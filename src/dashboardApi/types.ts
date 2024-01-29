// GITHUB

export type GithubContributor = {
  numberOfCommits: number;
  id: string;
  avatar: string | undefined;
};

export type SubscanBlockchainMetadata = {
  avgBlockTime: string;
};

export type GeneralSubscanDailyListData = {
  list: Array<{
    total: number;
  }>;
};

export type GenericQNTractionConnection = {
  totalCount: number;
};

export type GenericQNTractionItem = {
  createdAt: string;
};

export type ChannelsQueryData = {
  channelsConnection: GenericQNTractionConnection;
  channels: GenericQNTractionItem[];
};

export type VideosConnectionData = {
  videosConnection: GenericQNTractionConnection;
};

export type VideosQueryData = {
  videos: GenericQNTractionItem[];
};

export type CommentsAndReactionsData = {
  commentsConnection: GenericQNTractionConnection;
  commentReactionsConnection: GenericQNTractionConnection;
  videoReactionsConnection: GenericQNTractionConnection;
  comments: GenericQNTractionItem[];
  commentReactions: GenericQNTractionItem[];
  videoReactions: GenericQNTractionItem[];
};

export type NFTBoughtEventsData = {
  nftBoughtEvents: Array<{
    price: string;
    createdAt: string;
  }>;
};

export type Avatar = {
  avatarUri: string;
} | null;

export type TeamCouncilQNData = {
  electionRounds: [
    null,
    {
      cycleId: number;
      endedAtTime: string;
    }
  ];
  councilMembers: Array<{
    member: {
      handle: string;
      metadata: {
        avatar: Avatar;
        externalResources: Array<{
          type: string;
          value: string;
        }>;
      };
      councilMembers: Array<{ id: string }>;
    };
  }>;
};

export type TeamWorkingGroupQNData = {
  workingGroups: Array<{
    id: string;
    budget: string;
    workers: Array<{
      isActive: boolean;
      isLead: boolean;
      membership: {
        handle: string;
        metadata: {
          avatar: Avatar;
        };
      };
    }>;
  }>;
};

export type TeamWorkingGroupResult = {
  [key: string]: {
    workers: Array<{ handle: string; isLead: boolean; avatar: string | null }>;
    budget: number;
  };
};

export type TeamCouncilResult = Array<{
  avatar?: string;
  handle: string;
  socials: Array<{
    type: string;
    value: string;
  }>;
  timesServed: number;
}>;

export type TweetScoutScoreData = {
  score: number;
};

export type TweetScoutGeneralData = {
  followers_count: number;
};

export type TweetScoutAPITopFollowers = Array<{
  avatar: string;
  name: string;
  screeName: string;
  followersCount: number;
}>;

export type TweetScoutTopFollowers = Array<{
  avatar: string;
  name: string;
  screenName: string;
  followersCount: number;
}>;

export type TelegramAPIResult = {
  ok: boolean;
  result: number;
};

export type DiscordAPIEvent = {
  id: string;
  channel_id: string;
  name: string;
  scheduled_start_time: string;
  description: string;
  image: string;
};

export type DiscordEvent = {
  image: string | null;
  name: string;
  scheduledStartTime: string;
  description: string;
  location: string;
};

export type DiscordUser = {
  joined_at: string;
  user: {
    id: string;
  };
};

export type SubscanPriceHistoryListData = {
  list: Array<{
    feed_at: number;
    price: string;
  }>;
};

export type SubscanUniqueTokenData = {
  detail: {
    JOY: {
      inflation: string;
      bonded_locked_balance: string;
    };
  };
};

export type TokenQNMintingData = {
  channelRewardClaimedEvents: Array<{
    amount: string;
  }>;
  requestFundedEvents: Array<{
    amount: string;
  }>;
  workers: Array<{
    payouts: Array<{
      amount: string;
      createdAt: string;
    }>;
  }>;
  councilMembers: Array<{
    rewardpaymenteventcouncilMember: Array<{
      paidBalance: string;
      createdAt: string;
    }>;
  }>;
  budgetSpendingEvents: Array<{
    createdAt: string;
    amount: string;
    rationale: string | null;
  }>;
};

export type TimestampToValueTupleArray = Array<[number, number]>;

export type CoingGeckoMarketChartRange = {
  prices: TimestampToValueTupleArray;
  market_caps: TimestampToValueTupleArray;
  total_volumes: TimestampToValueTupleArray;
};

export type SubscanAccountsList = Array<{
  balance: string;
}>;

export type SubscanAccountsData = {
  count: number;
  list: SubscanAccountsList;
};
