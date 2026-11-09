import { expect,it } from 'vitest';
import { robotsAllows,RobotsPolicy } from './robots.js';
import type { SafeNetwork } from '../network.js';

it('uses agent groups, merges them and honours longest matching rules',()=>{
  const rules='User-agent: *\nDisallow: /\nUser-agent: MohassanAI-Research\nDisallow: /private\nAllow: /private/public\nUser-agent: MohassanAI-Research\nDisallow: /secrets';
  expect(robotsAllows(rules,'https://example.com/public')).toBe(true);
  expect(robotsAllows(rules,'https://example.com/private')).toBe(false);
  expect(robotsAllows(rules,'https://example.com/private/public')).toBe(true);
  expect(robotsAllows(rules,'https://example.com/secrets')).toBe(false);
});
it('handles wildcard, end markers, UTF8 and encoded unreserved octets',()=>{
  const rules='User-agent: *\nDisallow: /*.pdf$\nDisallow: /%70rivate\nDisallow: /عربي\nAllow: /private';
  expect(robotsAllows(rules,'https://example.com/a.pdf')).toBe(false);
  expect(robotsAllows(rules,'https://example.com/a.pdf?view=1')).toBe(true);
  expect(robotsAllows(rules,'https://example.com/private')).toBe(true);
  expect(robotsAllows(rules,'https://example.com/%D8%B9%D8%B1%D8%A8%D9%8A')).toBe(false);
});
it('fails closed for unavailable robots and permits a missing robots document',async()=>{
  let status=503;
  const network={validate:(url:string)=>new URL(url),request:async()=>({status,headers:{},body:Buffer.alloc(0)})} as unknown as SafeNetwork;
  const policy=new RobotsPolicy(network);
  await expect(policy.assertAllowed('https://example.com/a')).rejects.toMatchObject({code:'RESEARCH_ROBOTS_UNAVAILABLE'});
  status=404;await expect(policy.assertAllowed('https://example.com/a')).resolves.toBeUndefined();
});
