import '@joystream/types'
import { WsProvider, ApiPromise } from "@polkadot/api";
import { ChainProperties, Hash } from "@polkadot/types/interfaces";
import { config } from "dotenv";
import BN from "bn.js";
import fetch from "cross-fetch"
import { AnyJson } from "@polkadot/types/types";
import {
  PalletWorkingGroupGroupWorker as Worker,
  PalletReferendumReferendumStage as ReferendumStage,
  PalletCouncilCouncilStageUpdate as CouncilStageUpdate,
  PalletVestingVestingInfo,
} from '@polkadot/types/lookup'
import { Vec } from '@polkadot/types';
import { HexString } from '@polkadot/util/types';
import { perbillToPercent, percentToPerbill } from './utils';

// Init .env config
config();

// Query node
if(process.env.QUERY_NODE === undefined){
  throw new Error("Missing QUERY_NODE in .env!");
}
const QUERY_NODE = process.env.QUERY_NODE;
const VESTING_STRING_HEX = "0x76657374696e6720";
const ERAS_PER_DAY = 4;
const ERAS_PER_YEAR = ERAS_PER_DAY * 365

type SystemData = {
  chain: string
  nodeName: string
  nodeVersion: string
  peerCount: number
}

type CouncilData = {
  members_count: number
  election_stage: string
}

type ValidatorsData = {
  count: number
  validators: AnyJson
  total_stake: number // in JOY
}

type MembershipData = {
  platform_members: number
}

type RolesData = {
  storage_providers: number
}

type ForumData = {
  posts: number
  threads: number
}

type MediaData = {
  media_files: number | null
  size: number | null
  activeCurators: number
  channels: number | null
}

type RuntimeData = {
  spec_name: string
  impl_name: string
  spec_version: number
  impl_version: number
}

type NetworkStatus = {
  totalIssuance: number // In JOY
  vestingLockedIssuance: number // In JOY
  system: SystemData
  finalizedBlockHeight: number
  council: CouncilData,
  validators: ValidatorsData
  memberships: MembershipData
  roles: RolesData
  forum: ForumData
  media: MediaData
  runtimeData: RuntimeData
}

export class JoyApi {
  endpoint: string;
  tokenDecimals!: number;
  isReady: Promise<[ApiPromise, ChainProperties]>;
  api!: ApiPromise;

  protected cachedNetworkStatus: {
    cachedAtBlock: number
    value: NetworkStatus
  } | undefined

  constructor(endpoint?: string) {
    const wsEndpoint =
      endpoint || process.env.PROVIDER || "ws://127.0.0.1:9944";
    this.endpoint = wsEndpoint;
    this.isReady = (async () => {
      const api = await new ApiPromise({ provider: new WsProvider(wsEndpoint) })
        .isReadyOrError;
      const chainProperties = await api.rpc.system.properties()
      const result: [ApiPromise, ChainProperties] = [api, chainProperties]
      return result;
    })();
  }

  get init(): Promise<JoyApi> {
    return this.isReady.then(([api, chainProperties]) => {
      this.api = api;
      this.tokenDecimals = chainProperties.tokenDecimals.unwrap()[0].toNumber()
      return this;
    });
  }

  toJOY(hapi: BN): number {
    try {
      // <= 900719 JOY - we keep the decimals
      return hapi.toNumber() / Math.pow(10, this.tokenDecimals)
    } catch {
      // > 900719 JOY - we discard the decimals
      const joyValue = hapi.div(new BN(Math.pow(10, this.tokenDecimals)))

      // TODO: Temporary "fix". Root of problem needs to be found!
      // (context: function vestingLockedJOY() produces a *very* large value)
      if(joyValue.gte(new BN(Number.MAX_SAFE_INTEGER)))
        return Number.MAX_SAFE_INTEGER

      return joyValue.toNumber()
    }
  }

  toHAPI(joy: number): BN {
    if (joy * Math.pow(10, this.tokenDecimals) > Number.MAX_SAFE_INTEGER) {
      // > 900719 JOY - we discard the decimals
      return new BN(joy).mul(new BN(Math.pow(10, this.tokenDecimals)))
    } else {
      // <= 900719 JOY, we keep the decimals
      return new BN(Math.round(joy * Math.pow(10, this.tokenDecimals)))
    }
  }

  async qnQuery<T>(query: string): Promise<T | null> {
    // TODO: Typesafe QueryNodeApi
    try {
      const res = await fetch(QUERY_NODE, {
        method: 'POST',
        headers: { 'Content-type' : 'application/json' },
        body: JSON.stringify({ query })
      });

      if(res.ok){
        let responseData = (await res.json()).data;
        return responseData
      } else {
        console.error('Invalid query node response status', res.status)
      }
    } catch(e) {
      console.error('Query node fetch error:', e)
    }

    return null
  }

  async totalIssuanceInJOY(blockHash?: Hash): Promise<number> {
    const issuanceInHAPI =
      blockHash === undefined
        ? await this.api.query.balances.totalIssuance()
        : await this.api.query.balances.totalIssuance.at(blockHash);

    return this.toJOY(issuanceInHAPI)
  }

  async vestingLockedJOY(): Promise<number> {
    const finalizedHash = await this.finalizedHash()
    const { number: finalizedBlockHeight } = await this.api.rpc.chain.getHeader(finalizedHash)
    const vestingEntries = await this.api.query.vesting.vesting.entriesAt(finalizedHash)
    const getUnclaimableSum = (schedules: Vec<PalletVestingVestingInfo>) => (
      schedules.reduce(
        (sum, vesting) => {
          const claimableBlocks = finalizedBlockHeight.toNumber() - vesting.startingBlock.toNumber()
          if (claimableBlocks > 0) {
            const claimableAmount = vesting.perBlock.mul(new BN(claimableBlocks))
            return sum.add(vesting.locked.sub(claimableAmount))
          }
          return sum
        },
        new BN(0)
      )
    )
    const totalLockedHAPI = vestingEntries.reduce((sum, entry) =>
      sum.add(getUnclaimableSum(entry[1].unwrap())),
      new BN(0)
    )

    return this.toJOY(totalLockedHAPI)
  }

  async curators(): Promise<Worker[]> {
    return (await this.api.query.contentWorkingGroup.workerById.entries())
      .map(([, worker]) => worker.unwrap());
  }

  async activeCurators(): Promise<number> {
    return (await this.curators()).length;
  }

  async dataObjectsStats(
    storageDataObjects?: Array<{ size: string }>
  ): Promise<{ count: number; size: number }> {
    const stats = { count: 0, size: 0 }

    if (storageDataObjects) {
      stats.count = storageDataObjects.length
      stats.size = storageDataObjects.reduce((prev, { size }) => prev + Number(size), 0)

      return stats
    }

    // Supports size up to 8192 TB (because JS MAX_SAFE_INTEGER is 9007199254740991)
    (await this.api.query.storage.bags.entries())
      .forEach(([, bag]) => {
        stats.count += bag.objectsNumber.toNumber()
        stats.size += bag.objectsTotalSize.toNumber()
      });

    return stats
  }

  async systemData(): Promise<SystemData> {
    let peers = 0
    try {
      peers = (await this.api.rpc.system.peers()).length
    } catch(e) {
      console.warn(`api.rpc.system.peers not available on ${this.endpoint}`)
    }
    const [chain, nodeName, nodeVersion] = await Promise.all([
      this.api.rpc.system.chain(),
      this.api.rpc.system.name(),
      this.api.rpc.system.version(),
    ]);

    return {
      chain: chain.toString(),
      nodeName: nodeName.toString(),
      nodeVersion: nodeVersion.toString(),
      peerCount: peers,
    };
  }

  async finalizedHash() {
    return this.api.rpc.chain.getFinalizedHead();
  }

  async finalizedBlockHeight(): Promise<number> {
    const finalizedHash = await this.finalizedHash();
    const { number } = await this.api.rpc.chain.getHeader(`${finalizedHash}`);
    return number.toNumber();
  }

  async runtimeData(): Promise<RuntimeData> {
    const runtimeVersion = await this.api.rpc.state.getRuntimeVersion(
      `${await this.finalizedHash()}`
    );
    return {
      spec_name: runtimeVersion.specName.toString(),
      impl_name: runtimeVersion.implName.toString(),
      spec_version: runtimeVersion.specVersion.toNumber(),
      impl_version: runtimeVersion.implVersion.toNumber()
    };
  }

  parseElectionStage(electionStage: ReferendumStage, councilStage: CouncilStageUpdate): string {
    if (councilStage.stage.isIdle) {
      return "Not running";
    }

    if (councilStage.stage.isAnnouncing) {
      return "Announcing"
    }

    if (electionStage.isVoting) {
      return "Voting"
    }

    return "Revealing"
  }

  async councilData(): Promise<CouncilData> {
    const [councilMembers, electionStage, councilStage] = await Promise.all([
      this.api.query.council.councilMembers(),
      this.api.query.referendum.stage(),
      this.api.query.council.stage()
    ]);

    return {
      members_count: councilMembers.length,
      election_stage: this.parseElectionStage(electionStage, councilStage)
    };
  }

  async validatorsData(): Promise<ValidatorsData> {
    const validators = await this.api.query.session.validators();
    const era = await this.api.query.staking.currentEra();
    const totalStake = era.isSome ?
      await this.api.query.staking.erasTotalStake(era.unwrap())
      : new BN(0);

    return {
      count: validators.length,
      validators: validators.toJSON(),
      total_stake: this.toJOY(totalStake),
    };
  }

  async membershipData(): Promise<MembershipData> {
    // Member ids start from 0, so nextMemberId === number of members created
    const membersCreated = await this.api.query.members.nextMemberId();
    return {
      platform_members: membersCreated.toNumber(),
    };
  }

  async rolesData(): Promise<RolesData> {
    const storageWorkersCount = (await this.api.query.storageWorkingGroup.workerById.keys()).length

    return {
      // This includes the storage lead!
      storage_providers: storageWorkersCount
    };
  }

  async forumData(): Promise<ForumData> {
    const [nextPostId, nextThreadId] = (await Promise.all([
      this.api.query.forum.nextPostId(),
      this.api.query.forum.nextThreadId(),
    ]));

    return {
      posts: nextPostId.toNumber() - 1,
      threads: nextThreadId.toNumber() - 1,
    };
  }

  async mediaData(): Promise<MediaData> {
    const [qnData, activeCurators] = await Promise.all([
      this.qnQuery<{
        channelsConnection: { totalCount: number };
        storageDataObjects: Array<{ size: string }>;
      }>(`
        {
          channelsConnection {
            totalCount
          }
          storageDataObjects(limit: 99999999, where: { deletedAt_all: false }) {
            size
          }
        }
      `),
      this.activeCurators()
    ]);

    const channels = qnData ? qnData.channelsConnection.totalCount : (await this.api.query.content.channelById.keys()).length
    const { count: dataObjectsCount, size: dataObjectsSize } = await this.dataObjectsStats(qnData?.storageDataObjects)

    return {
      media_files: dataObjectsCount,
      size: dataObjectsSize,
      activeCurators,
      channels
    };
  }

  /**
   * Calculates the amount of JOY tokens that are currently in circulation.
   *
   * It is done by going through all accounts which have locks associated
   * with them and summing the amounts of all the vesting locks. That computed
   * value is then subtracted from the total supply of tokens to get the final result.
   *
   * Overview of the algorithm:
   * 1. Fetch relevant lock data of all accounts
   * 2. Per account, loop through all of the locks and find the vesting lock value
   * 3. Fetch all of the system.account data for all of the accounts that have a vesting lock
   * 4. Calculate the total locked amount by summing the smallest of the following:
   *      - the vesting lock value
   *      - the free balance
   * 5. Fetch the current total supply of tokens
   * 6. Subtract the total locked amount from the total supply to get
   *    the amount of tokens that are currently in circulation.
   */

  async calculateCirculatingSupply() {
    // Initialization of array with following information:
    // - address: an address with a vesting lock
    // - amount: the vesting value corresponding to the address
    type AccountVestingLock = { address: string; amount: BN };
    const accountVestingLockData: AccountVestingLock[] = []

    // Fetch lock data for all of the accounts that have any kind of lock
    const lockData = await this.api.query.balances.locks.entries();

    // Loop through the previously fetched lockData:
    // - storageKey holds the address of the account
    // - palletBalances holds the data for the array of locks associated with the account
    //   - example of palletBalances: [
    //     { id: 'vesting', amount: 10000000 },
    //     { id: 'staking', amount: 10000000 }
    //   ]
    //
    for (let [storageKey, palletBalances] of lockData) {
      // Find potential vesting lock by looping through all of the locks associated with the account
      // and comparing the id of the lock to the id of a qualifying vesting lock. As there is only
      // one vesting lock per acccount, we simply return as soon as we have found one.
      // - example of an entry in palletBalances: { id: 'vesting', amount: 10000000 }
      const vestingLock = palletBalances.find(({ id }) => id.toString() === VESTING_STRING_HEX)

      // If there is a vesting lock, we store it into the accountVestingLockData array for later use.
      if(vestingLock) {
        accountVestingLockData.push({
          address: storageKey.args[0].toString(),
          amount: vestingLock.amount.toBn(),
        });
      }
    }

    // Fetch all of the system.account data for all of the accounts that have a vesting lock
    // (i.e., all accounts found in accountVestingLockData)
    const systemAccounts = await this.api.query.system.account.multi(accountVestingLockData.map(({ address }) => address));

    // Loop through systemAccount data and calculate the total locked
    // amount by summing the smallest of the following:
    // - the vesting lock value
    // - the free balance
    const totalLockedAmount = systemAccounts.reduce((accumulator, systemAccount, index) => {
      // The reasoning behind the following line is:
      // - the total amount of tokens in an account is the sum of the free and reserved balance
      //   -> but, the locks only apply to the free portion of that sum
      // - however, there is a bug which can cause vesting lock amounts to be
      //   much greater than the actual (free) account balance
      // - so, the total amount of vesting-locked tokens that exist in an account is
      //   the minimum value between the vesting lock value and the free balance
      //   (i.e., accountVestingLockData[index].amount and systemAccount.data.free in this case)
      return accumulator.add(BN.min(accountVestingLockData[index].amount, systemAccount.data.free));
    }, new BN(0));

    // Fetch the current total supply of tokens
    const totalSupply = await this.totalIssuanceInJOY();

    // Subtract the total supply from the total locked amount to get
    // the amount of tokens that are currently in circulation.
    return totalSupply - this.toJOY(totalLockedAmount);
  }

  async getValidatorReward(startBlockHash: HexString, endBlockHash: HexString) {
    let totalReward = 0;
    const startEra = Number(
      (await (await this.api.at(startBlockHash)).query.staking.activeEra()).unwrap().index
    );
    const endEra = Number(
      (await (await this.api.at(endBlockHash)).query.staking.activeEra()).unwrap().index
    );
    for (let i = startEra; i <= endEra; i++) {
      const reward = await (await this.api.at(endBlockHash)).query.staking.erasValidatorReward(i);

      if (!reward.isNone) {
        totalReward += this.toJOY(reward.unwrap());
      }
    }
    return totalReward;
  }

  async getYearOfValidatorRewards() {
    const finalizedHeadHash = await this.finalizedHash();
    const { number: blockNumber } = await this.api.rpc.chain.getHeader(`${finalizedHeadHash}`);
    const currentBlock = blockNumber.toBn();

    // Calculate block for exactly 1 year ago
    const startBlockHash = await this.api.rpc.chain.getBlockHash(currentBlock.subn((365 * 24 * 60 * 60) / 6));
    const endBlockHash = await this.api.rpc.chain.getBlockHash(currentBlock);

    return await this.getValidatorReward(startBlockHash.toHex(), endBlockHash.toHex());
  }

  async APR() {
    const activeValidatorAddresses = await this.api.query.session.validators();
    const validators = await this.api.query.staking.validators.entries();
    const activeValidators = validators.filter(([key, _]) =>
      activeValidatorAddresses.includes(key.args[0].toString())
    );

    const activeEra = await this.api.query.staking.activeEra();
    const erasRewards = await this.api.derive.staking.erasRewards();

    // Average reward in an era for one validator.
    const averageRewardInAnEra = erasRewards
      .reduce((acc, { eraReward }) => acc.add(eraReward), new BN(0))
      .divn(erasRewards.length)
      .divn(activeValidators.length);

    // Average total stake for one validator
    const averageTotalStakeInCurrentEra = (
      await this.api.query.staking.erasTotalStake(activeEra.unwrap().index.toNumber())
    )
      .toBn()
      .divn(activeValidators.length);

    // Average commission for one validator.
    const averageCommission = activeValidators
      .reduce((acc, validator) => acc.add(validator[1].commission.toBn()), new BN(0))
      .divn(activeValidators.length);

    const apr = perbillToPercent(
      averageRewardInAnEra
        .muln(ERAS_PER_YEAR)
        .mul(percentToPerbill(100).sub(averageCommission))
        .div(averageTotalStakeInCurrentEra)
    );

    return apr;
  }

  async getInflationPercentValue () {
    const finalizedHeadHash = await this.finalizedHash();
    const { number: blockNumber } = await this.api.rpc.chain.getHeader(`${finalizedHeadHash}`);
    const currentBlock = blockNumber.toBn();

    // Calculate block for exactly 1 year ago
    const blockHashAYearAgo = await this.api.rpc.chain.getBlockHash(currentBlock.subn((365 * 24 * 60 * 60) / 6));

    const totalSupplyAYearAgo = await this.totalIssuanceInJOY(blockHashAYearAgo);
    const totalSupply = await this.totalIssuanceInJOY();

    return ((totalSupply - totalSupplyAYearAgo) / totalSupplyAYearAgo) * 100;
  }

  protected async fetchNetworkStatus(): Promise<NetworkStatus> {
    const [
      [
        totalIssuanceInJOY,
        system,
        finalizedBlockHeight,
        council,
        validators,
        memberships,
        roles,
        forum,
        media,
        vestingLockedJOY,
      ], [
        runtimeData
      ]
    ] = await Promise.all([
      // Split into chunks of 10, because the tsc compiler will use a tuple of size 10 as Promise.all generic 
      Promise.all([
        this.totalIssuanceInJOY(),
        this.systemData(),
        this.finalizedBlockHeight(),
        this.councilData(),
        this.validatorsData(),
        this.membershipData(),
        this.rolesData(),
        this.forumData(),
        this.mediaData(),
        this.vestingLockedJOY(),
      ]),
      Promise.all([
        this.runtimeData()
      ])
    ])
    return {
      totalIssuance: totalIssuanceInJOY,
      vestingLockedIssuance: vestingLockedJOY,
      system,
      finalizedBlockHeight,
      council,
      validators,
      memberships,
      roles,
      forum,
      media,
      runtimeData
    }
  }

  async getNetworkStatus(): Promise<NetworkStatus> {
    const currentBlock = (await this.api.derive.chain.bestNumber()).toNumber()
    if (currentBlock !== this.cachedNetworkStatus?.cachedAtBlock) {
      const status = await this.fetchNetworkStatus()
      this.cachedNetworkStatus = { cachedAtBlock: currentBlock, value: status }
    }
    return this.cachedNetworkStatus.value
  }
}
