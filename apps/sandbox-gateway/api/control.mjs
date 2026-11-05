import { Sandbox } from '@vercel/sandbox';
import { createGatewayHandler } from '../control.mjs';
const handler=createGatewayHandler({Sandbox});
export async function POST(request){return handler(request);}
export function GET(){return Response.json({error:{code:'UNAUTHORIZED'}},{status:401,headers:{'Cache-Control':'no-store'}});}
