import assert from "assert";
import { config } from "dotenv";
import { Octokit } from "octokit";
import axios from "axios";
import {
  REST,
  Routes,
  GuildScheduledEvent,
  User,
  GuildMember,
  Channel,
  GuildChannel,
} from "discord.js";

import { JoyApi } from "../joyApi";

import {
  fetchGenericAPIData,
  getNumberOfGithubItemsFromPageNumbers,
  getNumberOfQNItemsInLastWeek,
  getTotalPriceOfQNItemsInLastWeek,
  getTweetscoutLevel,
  hapiToJoy,
  paginatedQNFetch,
  separateQNDataByWeek,
  separateQNDataByWeekAndAmount,
} from "./utils";
import {
  GithubContributor,
  SubscanBlockchainMetadata,
  GeneralSubscanDailyListData,
  GenericQNTractionItem,
  ChannelsQueryData,
  VideosConnectionData,
  CommentsAndReactionsData,
  NFTBoughtEventsData,
  TeamWorkingGroupQNData,
  TeamCouncilQNData,
  TeamWorkingGroupResult,
  TeamCouncilResult,
  TweetScoutScoreData,
  TweetScoutGeneralData,
  TweetScoutTopFollowers,
  TelegramAPIResult,
  DiscordUser,
  DiscordAPIEvent,
  DiscordEvent,
  TweetScoutAPITopFollowers,
} from "./types";
import { TEAM_QN_QUERIES, TRACTION_QN_QUERIES } from "./queries";
import { getDateWeeksAgo, getDateMonthsAgo, getYearMonthDayString } from "../utils";

config();

assert(process.env.GITHUB_AUTH_TOKEN, "Missing environment variable: GITHUB_AUTH_TOKEN");
assert(process.env.SUBSCAN_API_KEY, "Missing environment variable: SUBSCAN_API_KEY");
assert(process.env.TWEETSCOUT_API_KEY, "Missing environment variable: TWEETSCOUT_API_KEY");
assert(process.env.TELEGRAM_BOT_ID, "Missing environment variable: TELEGRAM_BOT_ID");
assert(process.env.DISCORD_BOT_TOKEN, "Missing environment variable: DISCORD_BOT_TOKEN");
assert(
  process.env.DISCORD_SERVER_GUILD_ID,
  "Missing environment variable: DISCORD_SERVER_GUILD_ID"
);

const GITHUB_AUTH_TOKEN = process.env.GITHUB_AUTH_TOKEN;
const SUBSCAN_API_KEY = process.env.SUBSCAN_API_KEY;
const TWEETSCOUT_API_KEY = process.env.TWEETSCOUT_API_KEY;
const TELEGRAM_BOT_ID = process.env.TELEGRAM_BOT_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_SERVER_GUILD_ID = process.env.DISCORD_SERVER_GUILD_ID;

const GITHUB_JOYSTREAM_ORGANIZATION_NAME = "joystream";
const BLOCKS_IN_A_WEEK = 10 * 60 * 24 * 7;

export class DashboardAPI {
  githubAPI: Octokit;
  joyAPI: JoyApi;
  discordAPI: REST;

  constructor() {
    this.githubAPI = new Octokit({ auth: GITHUB_AUTH_TOKEN });
    this.joyAPI = new JoyApi("wss://rpc.joyutils.org");
    this.discordAPI = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  }

  async fetchSubscanData<T>(url: string, data?: any) {
    try {
      const response = axios({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": SUBSCAN_API_KEY,
        },
        data,
      });

      return (await response).data.data as T;
    } catch (e) {
      console.log(e);
      return null;
    }
  }

  async fetchAllRepoCommits(repoName: string, since: string) {
    const MAX_COMMIT_NUMBER_PER_PAGE = 100;
    const data = [];
    let page = 1;

    while (true) {
      const { data: pageData } = await this.githubAPI.request(
        "GET /repos/{username}/{repo}/commits",
        {
          page,
          username: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
          repo: repoName,
          per_page: MAX_COMMIT_NUMBER_PER_PAGE,
          since,
        }
      );

      data.push(...pageData);

      if (pageData.length < MAX_COMMIT_NUMBER_PER_PAGE) {
        break;
      }

      page++;
    }

    return data;
  }

  async fetchRepoInformation(repoName: string) {
    const twoMonthsAgoDate = getDateMonthsAgo(2);

    const [
      { data: generalRepoInformation },
      { headers: pullRequestHeaders },
      { headers: commitHeaders },
      { data: contributors },
      commits,
    ] = await Promise.all([
      this.githubAPI.request("GET /repos/{username}/{repo}", {
        username: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
        repo: repoName,
      }),
      this.githubAPI.request("GET /repos/{owner}/{repo}/pulls", {
        owner: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
        repo: repoName,
        per_page: 1,
        page: 1,
      }),
      this.githubAPI.request("GET /repos/{username}/{repo}/commits", {
        username: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
        repo: repoName,
        per_page: 1,
        page: 1,
      }),
      this.githubAPI.request("GET /repos/{owner}/{repo}/contributors", {
        owner: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
        repo: repoName,
        per_page: 5000,
      }),
      this.fetchAllRepoCommits(repoName, twoMonthsAgoDate.toISOString()),
    ]);

    const numberOfPullRequests = getNumberOfGithubItemsFromPageNumbers(pullRequestHeaders.link);

    return {
      name: repoName,
      numberOfStars: generalRepoInformation.stargazers_count,
      numberOfCommits: getNumberOfGithubItemsFromPageNumbers(commitHeaders.link),
      numberOfOpenIssues: generalRepoInformation.open_issues_count - numberOfPullRequests,
      numberOfPullRequests,
      contributors,
      commits,
    };
  }

  async fetchGithubUsersRealName(githubUsername: string) {
    const {
      data: { name },
    } = await this.githubAPI.request("GET /users/{username}", {
      username: githubUsername,
    });

    return name;
  }

  async getTractionData() {
    // ===============
    // QUERY NODE DATA
    // ===============
    let totalNumberOfChannels = null;
    let totalNumberOfChannelsWeeklyChange = null;
    let weeklyChannelData = null;
    let totalNumberOfVideos = null;
    let totalNumberOfVideosWeeklyChange = null;
    let weeklyVideoData = null;
    let totalNumberOfCommentsAndReactions = null;
    let totalNumberOfCommentsAndReactionsWeeklyChange = null;
    let weeklyCommentsAndReactionsData = null;
    let totalVolumeOfSoldNFTs = null;
    let totalVolumeOfSoldNFTsWeeklyChange = null;
    let weeklyVolumeOfSoldNFTs = null;

    const [
      channelsData,
      videosCountData,
      videosData,
      commentsAndReactionsData,
      nftBoughtEventsData,
    ] = await Promise.all([
      this.joyAPI.qnQuery<ChannelsQueryData>(TRACTION_QN_QUERIES.CHANNELS),
      this.joyAPI.qnQuery<VideosConnectionData>(TRACTION_QN_QUERIES.VIDEOS_CONNECTION),
      paginatedQNFetch<GenericQNTractionItem>(TRACTION_QN_QUERIES.VIDEOS),
      this.joyAPI.qnQuery<CommentsAndReactionsData>(TRACTION_QN_QUERIES.COMMENTS_AND_REACTIONS),
      this.joyAPI.qnQuery<NFTBoughtEventsData>(TRACTION_QN_QUERIES.NFT_BOUGHT_EVENTS),
    ]);

    if (channelsData) {
      const {
        channelsConnection: { totalCount },
        channels,
      } = channelsData;

      const numberOfChannelsAWeekAgo = totalCount - getNumberOfQNItemsInLastWeek(channels);

      totalNumberOfChannels = totalCount;
      totalNumberOfChannelsWeeklyChange =
        ((totalNumberOfChannels - numberOfChannelsAWeekAgo) / numberOfChannelsAWeekAgo) * 100;
      weeklyChannelData = separateQNDataByWeek(channels);
    }

    if (videosCountData && videosData) {
      const {
        videosConnection: { totalCount },
      } = videosCountData;

      const numberOfVideosAWeekAgo = totalCount - getNumberOfQNItemsInLastWeek(videosData);

      totalNumberOfVideos = videosCountData.videosConnection.totalCount;
      totalNumberOfVideosWeeklyChange =
        ((totalNumberOfVideos - numberOfVideosAWeekAgo) / numberOfVideosAWeekAgo) * 100;
      weeklyVideoData = separateQNDataByWeek(videosData);
    }

    if (commentsAndReactionsData) {
      const {
        commentsConnection: { totalCount: allTimeNumberOfComments },
        commentReactionsConnection: { totalCount: allTimeNumberOfCommentReactions },
        videoReactionsConnection: { totalCount: allTimeNumberOfVideoReactions },
        comments,
        commentReactions,
        videoReactions,
      } = commentsAndReactionsData;

      totalNumberOfCommentsAndReactions =
        allTimeNumberOfComments + allTimeNumberOfCommentReactions + allTimeNumberOfVideoReactions;

      const numberOfCommentsAndReactionsAWeekAgo =
        totalNumberOfCommentsAndReactions -
        getNumberOfQNItemsInLastWeek([...comments, ...commentReactions, ...videoReactions]);

      totalNumberOfCommentsAndReactionsWeeklyChange =
        ((totalNumberOfCommentsAndReactions - numberOfCommentsAndReactionsAWeekAgo) /
          numberOfCommentsAndReactionsAWeekAgo) *
        100;
      weeklyCommentsAndReactionsData = separateQNDataByWeek(
        [...comments, ...commentReactions, ...videoReactions].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        )
      );
    }

    if (nftBoughtEventsData) {
      const { nftBoughtEvents } = nftBoughtEventsData;

      totalVolumeOfSoldNFTs = hapiToJoy(
        nftBoughtEvents.reduce((acc: number, curr: any) => acc + Number(curr.price), 0)
      );

      const totalVolumeOfSoldNFTsAWeekAgo =
        totalVolumeOfSoldNFTs - getTotalPriceOfQNItemsInLastWeek(nftBoughtEvents);

      totalVolumeOfSoldNFTsWeeklyChange =
        ((totalVolumeOfSoldNFTs - totalVolumeOfSoldNFTsAWeekAgo) / totalVolumeOfSoldNFTsAWeekAgo) *
        100;
      weeklyVolumeOfSoldNFTs = separateQNDataByWeekAndAmount(nftBoughtEvents);
    }

    // ============
    // SUBSCAN DATA
    // ============
    let averageBlockTime = null;
    let totalNumberOfTransactions = null;
    let totalNumberOfTransactionsWeeklyChange = null;
    let totalNumberOfAccountHolders = null;
    let totalNumberOfAccountHoldersWeeklyChange = null;
    let numberOfDailyActiveAccounts = null;
    let numberOfDailyActiveAccountsWeeklyChange = null;

    const blockchainMetadata = await this.fetchSubscanData<SubscanBlockchainMetadata>(
      "https://joystream.api.subscan.io/api/scan/metadata"
    );

    if (blockchainMetadata) {
      averageBlockTime = blockchainMetadata.avgBlockTime;
    }

    const extrinsicData = await this.fetchSubscanData<GeneralSubscanDailyListData>(
      "https://joystream.api.subscan.io/api/scan/daily",
      {
        category: "extrinsic",
        start: "2022-12-01",
        format: "day",
        end: getYearMonthDayString(new Date()),
      }
    );

    if (extrinsicData) {
      const totalNumberOfTransactionsAWeekAgo = extrinsicData.list
        .slice(0, extrinsicData.list.length - 7)
        .reduce((acc: number, curr: any) => acc + curr.total, 0);

      totalNumberOfTransactions = extrinsicData.list.reduce(
        (acc: number, curr: any) => acc + curr.total,
        0
      );
      totalNumberOfTransactionsWeeklyChange =
        ((totalNumberOfTransactions - totalNumberOfTransactionsAWeekAgo) /
          totalNumberOfTransactionsAWeekAgo) *
        100;
    }

    const dailyAccountHolderData = await this.fetchSubscanData<GeneralSubscanDailyListData>(
      "https://joystream.api.subscan.io/api/scan/daily",
      {
        category: "AccountHolderTotal",
        start: getYearMonthDayString(getDateWeeksAgo(1)),
        format: "day",
        end: getYearMonthDayString(new Date()),
      }
    );

    if (dailyAccountHolderData) {
      const numberOfAccountHoldersAWeekAgo = dailyAccountHolderData.list[0].total;

      totalNumberOfAccountHolders =
        dailyAccountHolderData.list[dailyAccountHolderData.list.length - 1].total;
      totalNumberOfAccountHoldersWeeklyChange =
        ((totalNumberOfAccountHolders - numberOfAccountHoldersAWeekAgo) /
          numberOfAccountHoldersAWeekAgo) *
        100;
    }

    const dailyActiveAccountData = await this.fetchSubscanData<GeneralSubscanDailyListData>(
      "https://joystream.api.subscan.io/api/scan/daily",
      {
        category: "ActiveAccount",
        start: getYearMonthDayString(getDateWeeksAgo(1)),
        format: "day",
        end: getYearMonthDayString(new Date()),
      }
    );

    if (dailyActiveAccountData) {
      const numberOfActiveAccountsAWeekAgo = dailyActiveAccountData.list[0].total;

      // This takes the number of active accounts from yesterday, as the data for today is not yet fully complete.
      // During the early parts of the day, the number of active accounts "Today" will be super low and not representative.
      numberOfDailyActiveAccounts =
        dailyActiveAccountData.list[dailyActiveAccountData.list.length - 2].total;
      numberOfDailyActiveAccountsWeeklyChange =
        ((numberOfDailyActiveAccounts - numberOfActiveAccountsAWeekAgo) /
          numberOfActiveAccountsAWeekAgo) *
        100;
    }

    return {
      totalNumberOfChannels,
      totalNumberOfChannelsWeeklyChange,
      weeklyChannelData,
      totalNumberOfVideos,
      totalNumberOfVideosWeeklyChange,
      weeklyVideoData,
      totalNumberOfCommentsAndReactions,
      totalNumberOfCommentsAndReactionsWeeklyChange,
      weeklyCommentsAndReactionsData,
      totalVolumeOfSoldNFTs,
      totalVolumeOfSoldNFTsWeeklyChange,
      weeklyVolumeOfSoldNFTs,
      averageBlockTime,
      totalNumberOfTransactions,
      totalNumberOfTransactionsWeeklyChange,
      totalNumberOfAccountHolders,
      totalNumberOfAccountHoldersWeeklyChange,
      numberOfDailyActiveAccounts,
      numberOfDailyActiveAccountsWeeklyChange,
    };
  }

  async fetchDiscordUsers() {
    let after = "0";
    let usersResult: DiscordUser[] = [];

    while (true) {
      const users = (await this.discordAPI.get(Routes.guildMembers(DISCORD_SERVER_GUILD_ID), {
        query: new URLSearchParams([
          ["limit", "1000"],
          ["after", after],
        ]),
      })) as DiscordUser[];

      usersResult = [...usersResult, ...users];

      if (users.length === 0) {
        break;
      }

      after = users[users.length - 1].user.id;
    }

    return usersResult;
  }

  async getDiscordEventLocation(channelId: string) {
    const channel = (await this.discordAPI.get(Routes.channel(channelId))) as GuildChannel;

    return channel.name;
  }

  async getCommunityData() {
    let twitterFollowerCount = null;
    let discordMemberCount = null;
    let discordMemberCountMonthlyChange = null;
    let telegramMemberCount = null;
    let tweetscoutScore = null;
    let tweetscoutLevel = null;
    let featuredFollowers: TweetScoutTopFollowers = [];
    let discordEvents: DiscordEvent[] = [];

    const [
      tweetScoutScoreData,
      joystreamDAOInfo,
      topFollowers,
      telegramMemberCountResult,
      events,
      discordUsers,
    ] = await Promise.all([
      fetchGenericAPIData<TweetScoutScoreData>({
        url: "https://api.tweetscout.io/api/score/joystreamdao",
        headers: {
          ApiKey: TWEETSCOUT_API_KEY,
        },
      }),
      fetchGenericAPIData<TweetScoutGeneralData>({
        url: "https://api.tweetscout.io/api/info/joystreamdao",
        headers: {
          ApiKey: TWEETSCOUT_API_KEY,
        },
      }),
      fetchGenericAPIData<TweetScoutAPITopFollowers>({
        url: "https://api.tweetscout.io/api/top-followers/joystreamdao",
        headers: {
          ApiKey: TWEETSCOUT_API_KEY,
        },
      }),
      fetchGenericAPIData<TelegramAPIResult>({
        url: `https://api.telegram.org/bot${TELEGRAM_BOT_ID}/getChatMembersCount?chat_id=@JoystreamOfficial`,
      }),
      this.discordAPI.get(Routes.guildScheduledEvents(DISCORD_SERVER_GUILD_ID)) as Promise<
        DiscordAPIEvent[]
      >,
      this.fetchDiscordUsers(),
    ]);

    if (tweetScoutScoreData) {
      tweetscoutScore = tweetScoutScoreData.score;
      tweetscoutLevel = getTweetscoutLevel(tweetScoutScoreData.score);
    }

    if (joystreamDAOInfo) {
      twitterFollowerCount = joystreamDAOInfo.followers_count;
    }

    if (topFollowers) {
      featuredFollowers = topFollowers.map(({ avatar, name, screeName, followersCount }) => ({
        avatar,
        name,
        screenName: screeName,
        followersCount,
      }));
    }

    if (telegramMemberCountResult) {
      telegramMemberCount = telegramMemberCountResult.result;
    }

    if (events.length != 0) {
      discordEvents = await Promise.all(
        events.map(async (event) => ({
          image: event.image
            ? `https://cdn.discordapp.com/guild-events/${event.id}/${event.image}.png?size=1024`
            : null,
          name: event.name,
          scheduledStartTime: event.scheduled_start_time,
          description: event.description,
          location: await this.getDiscordEventLocation(event.channel_id),
        }))
      );
    }

    if (discordUsers.length != 0) {
      const oneMonthAgo = getDateMonthsAgo(1);

      const numberOfUsersJoinedInLastMonth = discordUsers.filter(
        (user) => new Date(user.joined_at) > oneMonthAgo
      ).length;
      const usersLastMonth = discordUsers.length - numberOfUsersJoinedInLastMonth;
      const percentChange = ((discordUsers.length - usersLastMonth) / usersLastMonth) * 100;

      discordMemberCount = discordUsers.length;
      discordMemberCountMonthlyChange = percentChange;
    }

    return {
      twitterFollowerCount,
      discordMemberCount,
      discordMemberCountMonthlyChange,
      telegramMemberCount,
      tweetscoutScore,
      tweetscoutLevel,
      featuredFollowers,
      discordEvents,
    };
  }

  async getTeamData() {
    let workingGroups: TeamWorkingGroupResult = {};
    let councilMembers: TeamCouncilResult = [];
    let currentCouncilTerm = null;
    let councilTermLengthInDays = null;
    let startOfCouncilElectionRound = null;
    let endOfCouncilElectionRound = null;
    let weeklyCouncilorSalaryInJOY = null;

    const [
      idlePeriodDuration,
      councilorReward,
      voteStageDuration,
      revealStageDuration,
      announcingPeriodDuration,
      councilData,
      workersData,
    ] = await Promise.all([
      this.joyAPI.api.consts.council.idlePeriodDuration.toNumber(),
      (await this.joyAPI.api.query.council.councilorReward()).toNumber(),
      this.joyAPI.api.consts.referendum.voteStageDuration.toNumber(),
      this.joyAPI.api.consts.referendum.revealStageDuration.toNumber(),
      this.joyAPI.api.consts.council.announcingPeriodDuration.toNumber(),
      this.joyAPI.qnQuery<TeamCouncilQNData>(TEAM_QN_QUERIES.COUNCIL),
      this.joyAPI.qnQuery<TeamWorkingGroupQNData>(TEAM_QN_QUERIES.WORKERS),
    ]);

    if (councilData) {
      const combinedLengthOfCouncilStages =
        idlePeriodDuration + voteStageDuration + revealStageDuration + announcingPeriodDuration;
      const approximatedLengthInSeconds = combinedLengthOfCouncilStages * 6;
      const startOfElectionRound = new Date(councilData.electionRounds[1].endedAtTime);
      const endOfElectionRound = new Date(councilData.electionRounds[1].endedAtTime);
      endOfElectionRound.setSeconds(
        startOfElectionRound.getSeconds() + approximatedLengthInSeconds
      );

      currentCouncilTerm = councilData.electionRounds[1].cycleId;
      councilTermLengthInDays = Math.round(approximatedLengthInSeconds / (60 * 60 * 24));
      startOfCouncilElectionRound = startOfElectionRound.toISOString();
      endOfCouncilElectionRound = endOfElectionRound.toISOString();
      weeklyCouncilorSalaryInJOY = hapiToJoy(councilorReward * BLOCKS_IN_A_WEEK);

      councilMembers = councilData.councilMembers.map(({ member }) => ({
        avatar: member.metadata.avatar?.avatarUri,
        handle: member.handle,
        socials: member.metadata.externalResources,
        timesServed: member.councilMembers.length,
      }));
    }

    if (workersData) {
      workingGroups = workersData.workingGroups.reduce((acc, wg) => {
        acc[wg.id] = {
          workers: wg.workers
            .filter((w: any) => w.isActive)
            .map((w: any) => ({
              handle: w.membership.handle,
              isLead: w.isLead,
              avatar: w.membership.metadata.avatar?.avatarUri,
            })),
          budget: hapiToJoy(Number(wg.budget)),
        };

        return acc;
      }, {} as TeamWorkingGroupResult);
    }

    return {
      council: {
        currentTerm: currentCouncilTerm,
        termLength: councilTermLengthInDays,
        electedOnDate: startOfCouncilElectionRound,
        nextElectionDate: endOfCouncilElectionRound,
        weeklySalaryInJOY: weeklyCouncilorSalaryInJOY,
        currentCouncil: councilMembers,
      },
      workingGroups,
    };
  }

  async getEngineeringData() {
    let totalNumberOfStars = 0;
    let totalNumberOfCommits = 0;
    let totalNumberOfCommitsThisWeek = 0;
    let totalNumberOfOpenPRs = 0;
    let totalNumberOfOpenIssues = 0;
    const githubContributors: { [key: string]: GithubContributor } = {};
    const commitData: { [key: string]: { [key: string]: number } } = {};

    const [
      {
        data: { public_repos, followers },
      },
      { data: repos },
    ] = await Promise.all([
      this.githubAPI.request("GET /orgs/{org}", {
        org: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
      }),
      this.githubAPI.request("GET /orgs/{org}/repos", {
        org: GITHUB_JOYSTREAM_ORGANIZATION_NAME,
        per_page: 1000,
      }),
    ]);

    const reposInformation = await Promise.all(
      repos.map((repo) => this.fetchRepoInformation(repo.name))
    );

    for (const repoInformation of reposInformation) {
      const {
        numberOfCommits,
        numberOfOpenIssues,
        numberOfPullRequests,
        numberOfStars,
        contributors,
        commits,
      } = repoInformation;

      totalNumberOfStars += numberOfStars;
      totalNumberOfCommits += numberOfCommits;
      totalNumberOfOpenIssues += numberOfOpenIssues;
      totalNumberOfOpenPRs += numberOfPullRequests;

      const weekAgoDate = getDateWeeksAgo(1);

      commits.forEach((commit) => {
        if (new Date(commit.commit.author.date) > weekAgoDate) {
          totalNumberOfCommitsThisWeek++;
        }

        const [_, month, day] = commit.commit.author.date.split("T")[0].split("-");

        if (!commitData[month]) {
          commitData[month] = {};
        }

        if (!commitData[month][day]) {
          commitData[month][day] = 0;
        }

        commitData[month][day]++;
      });

      contributors.forEach((contributor) => {
        if (contributor.login) {
          if (githubContributors[contributor.login]) {
            githubContributors[contributor.login].numberOfCommits += contributor.contributions;
          } else {
            githubContributors[contributor.login] = {
              numberOfCommits: contributor.contributions,
              id: contributor.login,
              avatar: contributor.avatar_url,
            };
          }
        }
      });
    }

    const topGithubContributors = await Promise.all(
      Object.values(githubContributors)
        .sort((a, b) => b.numberOfCommits - a.numberOfCommits)
        .slice(0, 21)
        .filter((contributor) => contributor.id !== "actions-user")
        .map(async (contributor) => ({
          ...contributor,
          name: await this.fetchGithubUsersRealName(contributor.id),
        }))
    );

    return {
      numberOfRepositories: public_repos,
      numberOfFollowers: followers,
      numberOfStars: totalNumberOfStars,
      numberOfCommits: totalNumberOfCommits,
      totalNumberOfCommitsThisWeek,
      numberOfOpenIssues: totalNumberOfOpenIssues,
      numberOfOpenPRs: totalNumberOfOpenPRs,
      contributors: topGithubContributors,
      commits: commitData,
    };
  }

  async getFullData() {
    // await this.joyAPI.init;
    // TODO: Fetching engineering data uses 383 API units. Plan this into cron job timing.
    // const engineeringData = await this.getEngineeringData();
    // console.log(engineeringData);
    // const tractionData = await this.getTractionData();
    // console.log(tractionData);
    // const communityData = await this.getCommunityData();
    // console.log(JSON.stringify(communityData, null, 2));
    // const teamData = await this.getTeamData();
    // console.log(JSON.stringify(teamData, null, 2));
  }
}
