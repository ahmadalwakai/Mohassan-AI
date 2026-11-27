export type AuthClass = 'anonymous' | 'member' | 'owner';
export type Transport = 'fastify' | 'next' | 'external';

export interface ClientCall {
  client: 'Web' | 'iOS' | 'Android' | 'Chrome' | 'Windows';
  method: string;
  path: string;
  file: string;
  line: number;
  memberVisible?: boolean;
  auth?: AuthClass;
  transport?: Transport;
  note?: string;
  ref?: string;
  request?: string;
  response?: string;
}

export interface ServerRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  auth: AuthClass;
  registrationPath?: string;
  authFile?: string;
  authLine?: number;
  request?: string;
  response?: string;
  note?: string;
}

export interface InventoryRow {
  method: string;
  path: string;
  transport: Transport;
  auth?: AuthClass;
  server?: ServerRoute;
  request?: string;
  response?: string;
  calls: ClientCall[];
}
