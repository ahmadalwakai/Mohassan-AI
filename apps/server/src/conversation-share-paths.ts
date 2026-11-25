const conversation = '/api/chat/conversations/:id';
const shares = '/api/chat/conversation-shares';

export const conversationSharePaths = {
  export: `${conversation}/export`,
  preview: `${conversation}/share/preview`,
  create: `${conversation}/share`,
  list: shares,
  revoke: `${shares}/:id`,
  public: `${shares}/public/:token`,
  settings: '/api/chat/conversation-share-settings',
} as const;

export const conversationShareMemberRoutes = [
  `GET ${conversationSharePaths.export}`,
  `POST ${conversationSharePaths.preview}`,
  `POST ${conversationSharePaths.create}`,
  `GET ${conversationSharePaths.list}`,
  `DELETE ${conversationSharePaths.revoke}`,
];

export const conversationSharePublicRoute = `GET ${conversationSharePaths.public}`;
