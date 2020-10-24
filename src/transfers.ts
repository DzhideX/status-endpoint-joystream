import { JoyApi, BURN_PAIR, BURN_ADDRESS } from "./joyApi";
import { Vec, Compact } from '@polkadot/types/codec';
import { EventRecord, Balance } from '@polkadot/types/interfaces';
import { db, refreshDb, Exchange, BlockProcessingError, BlockProcessingWarning, Burn } from './db';
import { ApiPromise } from "@polkadot/api";
import locks from "locks";
import Block from "@polkadot/types/generic/Block";
import { LookupSource } from "@joystream/types/augment/all";
import Extrinsic from "@polkadot/types/extrinsic/Extrinsic";
import { log, error } from './debug';

const processingLock = locks.createMutex();
const burningLock = locks.createMutex();

const joy = new JoyApi();

const BLOCK_PROCESSING_TIMEOUT = 10000;
const FIRST_BLOCK_TO_PROCESS = 1;
const PROBABILISTIC_FINALITY_DEPTH = 10;

// Known account we want to use (available on dev chain, with funds)

// Listen to all tx to Jsgenesis address
// Add them to exchanges. Calculate the Dollar Value, and log all the other info. Set completed to false.

// If for some reason we cannot process given block and all the attempts to do so fail,
// we log the fault block number, update the database and exit the process to avoid inconsistencies. 
async function critialExit(faultBlockNumber: number, reason?: string) {
  const logTime = new Date();
  await (await db)
    .defaults({ errors: [] as BlockProcessingError[] })
    .get('errors')
    .push({ blockNumber: faultBlockNumber, reason, logTime })
    .write();

  await (await db)
    .set('lastBlockProcessed', faultBlockNumber)
    .write();

  log('Critical error, extiting...');
  log('Faulty block:', faultBlockNumber);
  log('Reason:', reason);
  process.exit();
}

// Exectue the actual tokens burn
function autoburn(api: ApiPromise) {
  // We need to use the lock to prevent executing multiple burns in the same block, since it causes transaction priority errors
  burningLock.lock(async () => {
    const pendingBurnAmount = await joy.burnAddressBalance();
    if (pendingBurnAmount === 0) {
      burningLock.unlock();
      return;
    }
    log(`Executing automatic burn of ${ pendingBurnAmount } tokens`);
    try {
      await api.tx.balances
        .transfer(BURN_ADDRESS, 0)
        // We assume that required transaction fee is 0 (which is currently true)
        .signAndSend(BURN_PAIR, { tip: pendingBurnAmount }, async result => {
          if (result.status.isInBlock) {
            const blockHash = result.status.asInBlock.toHex();
            log(`Automatic burn of ${ pendingBurnAmount } included in block: ${blockHash}`);
            burningLock.unlock();
          }
          if (result.isError) {
            const statusType = result.status.type.toString() || 'Error';
            error(`Automatic burn of ${ pendingBurnAmount } tokens extrinsic failed with status: ${statusType}`);
            burningLock.unlock();
          }
        });
      } catch(e) {
        error(`Automatic burn of ${ pendingBurnAmount } tokens failed with: `, e);
        burningLock.unlock();
      }
  });
}

type TransferExtrinsicData = {
  senderAddress: string;
  recipientAddress: string;
  amount: number;
  tip: number;
}

function getTransferExtrinsicData(extrinsic: Extrinsic): TransferExtrinsicData {
  return {
    senderAddress: extrinsic.signer.toString(),
    recipientAddress: (extrinsic.args[0] as LookupSource).toString(),
    amount: (extrinsic.args[1] as Compact<Balance>).toNumber(),
    tip: extrinsic.tip.toNumber()
  }
}

function wasExtrinsicSuccesful(events: EventRecord[], index: number) {
  return events.some(({ event, phase }) => (
    event.section === 'system'
    && event.method === 'ExtrinsicSuccess'
    && phase.isApplyExtrinsic
    && phase.asApplyExtrinsic.toNumber() === index
  ))
}

async function processBlock(api: ApiPromise, block: Block) {
  const { header, extrinsics } = block;
  const blockNumber = header.number.toNumber();

  try {
    await new Promise(async (resolve, reject) => {
      // Set block processing timeout to avoid infinite lock
      const processingTimeout = setTimeout(
        () => reject('Block processing timeout'),
        BLOCK_PROCESSING_TIMEOUT
      );
      // Set lock to avoid processing multiple blocks at the same time
      processingLock.lock(async () => {
        console.log('\n');
        // Refresh db state before processing each new block
        await refreshDb(blockNumber);

        const { lastBlockProcessed = FIRST_BLOCK_TO_PROCESS - 1 } = (await db).valueOf();

        // Ignore blocks that are (or should be) already processed
        if (blockNumber <= lastBlockProcessed) {
          processingLock.unlock();
          clearTimeout(processingTimeout);
          return;
        }

        log(`Processing block #${ blockNumber }...`);

        const blockHash = header.hash;
        const events = await api.query.system.events.at(blockHash) as Vec<EventRecord>;
        const bestFinalized = (await api.derive.chain.bestNumberFinalized()).toNumber();
        const { sizeDollarPool: currentDollarPool = 0 } = (await db).valueOf();
        let sumDollarsInBlock = 0, sumTokensInBlock = 0;

        // Add warning if the block is not yet finalized
        if (blockNumber > bestFinalized) {
          await (await db)
            .defaults({ warnings: [] as BlockProcessingWarning[] })
            .get('warnings')
            .push({
              blockNumber,
              message: `Processing before finalized! Finalized: ${ bestFinalized }, Processing: ${ blockNumber }`,
              logTime: new Date()
            })
            .write();
        }

        const blockTimestamp = await api.query.timestamp.now.at(blockHash);
        // To calcultate the price we use parent hash (so all the transactions that happend in this block have no effect on it)
        const issuance = await joy.totalIssuance(blockHash);
        const price = joy.calcPrice(issuance, currentDollarPool);
        
        // Handlers
        const handleExchange = async (senderAddress: string, amount: number) => {
          const memo = await api.query.memo.memo.at(blockHash, senderAddress);
          const amountUSD = price * amount;
          let match: any = 'No address found'
          const parseAddress = (address: string) => {
            const regexps: RegExp[] = [
              new RegExp('(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}'),
              new RegExp('(q|p)[a-z0-9]{41}'),
              new RegExp('(4|8)[1-9A-HJ-NP-Za-km-z]{94}')
            ]
            for (let regexp of regexps) {
              let matches = address.match(regexp)
              if (matches!==null) {
                match = matches[0]
              }
            }
            return match
          }

          const exchange: Exchange = {
            sender: senderAddress,
            recipient: BURN_ADDRESS,
            senderMemo: memo.toString(),
            xmrAddress: parseAddress(memo.toString()),
            amount: amount,
            date: new Date(blockTimestamp.toNumber()),
            blockHeight: blockNumber,
            price: price,
            amountUSD: amountUSD,
            logTime: new Date(),
            status: 'PENDING'
          };

          await (await db)
            .defaults({ exchanges: [] as Exchange[] })
            .get('exchanges', [])
            .push(exchange)
            .write();

          sumDollarsInBlock += exchange.amountUSD;
          sumTokensInBlock  += exchange.amount;

          log('Exchange handled!', exchange);
        }

        const handleBurn = async (amount: number) => {
          const burn: Burn = {
            amount,
            blockHeight: blockNumber,
            date: new Date(blockTimestamp.toNumber()),
            logTime: new Date()
          }
          await (await db)
          .defaults({ burns: [] as Burn[] })
          .get('burns')
          .push(burn)
          .write();

          log('Burn handled!', burn);
        }

        // Processing extrinsics in the finalized block
        for (const [index, extrinsic] of Object.entries(extrinsics.toArray())) {
          if (!(extrinsic.method.section === 'balances' && extrinsic.method.method === 'transfer')) {
            continue;
          }
          
          const txSuccess = wasExtrinsicSuccesful(events.toArray(), parseInt(index));
          
          if (!txSuccess) {
            continue;
          }
          
          const { senderAddress, recipientAddress, amount, tip } = getTransferExtrinsicData(extrinsic);
          
          if (recipientAddress === BURN_ADDRESS && amount > 0) {
            await handleExchange(senderAddress, amount);
          }

          if (senderAddress === BURN_ADDRESS && tip > 0) {
            await handleBurn(tip);
          }
        }

        // We update the dollar pool after processing all transactions in this block
        await (await db)
          .set('sizeDollarPool', currentDollarPool - sumDollarsInBlock)
          .set('lastBlockProcessed', blockNumber)
          .write();

        log('Issuance at this block:', issuance);
        log('Token price at this block:', price);
        log('Exchanged tokens in this block:', sumTokensInBlock);
        log('Exchanged tokens value in this block:', `$${sumDollarsInBlock}`);
        log('Dollar pool after processing this block:', currentDollarPool - sumDollarsInBlock);

        autoburn(api);

        processingLock.unlock();
        clearTimeout(processingTimeout);
        resolve();
      });
    });
  } catch (e) {
    await critialExit(blockNumber, JSON.stringify(e));
  }
}

async function processPastBlocks(api: ApiPromise, from: number, to: number) {
  for (let blockNumber = from; blockNumber <= to; ++blockNumber) {
    const hash = await api.rpc.chain.getBlockHash(blockNumber);
    const { block } = await api.rpc.chain.getBlock(hash);
    try {
      await processBlock(api, block);
    } catch (e) {
      critialExit(block.header.number.toNumber(), JSON.stringify(e));
    }
  }
}

async function main() {
  // Create an await for the API
  const { api } = await joy.init;

  api.rpc.chain.subscribeNewHeads(async head => {
    const { lastBlockProcessed = FIRST_BLOCK_TO_PROCESS - 1 } = (await db).valueOf();
    const blockNumber = head.number.toNumber();
    const blockNumberToProcess = blockNumber - PROBABILISTIC_FINALITY_DEPTH;
    // Ignore already processed blocks and blocks before "FIRST_BLOCK_TO_PROCESS"
    if (blockNumberToProcess <= lastBlockProcessed || blockNumberToProcess < FIRST_BLOCK_TO_PROCESS) return;
    // Make sure all blocks between the last processed block and (including) current block to process are processed
    await processPastBlocks(api, lastBlockProcessed + 1, blockNumberToProcess);
  });
}

export default main;
