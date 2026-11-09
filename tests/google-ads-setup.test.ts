import { describe,it,expect } from 'vitest';
import { googleAdsSetupReport } from '../scripts/lib/google-ads-setup.ts';

const settings={GOOGLE_ADS_CLIENT_ID:'123456-fixture.apps.googleusercontent.com',GOOGLE_ADS_CLIENT_SECRET:'fixture-private-client-secret',GOOGLE_ADS_TOKEN_KEY:Buffer.alloc(32,7).toString('base64'),WEB_ORIGIN:'https://ads.example.test'};
describe('Google Ads setup inspection',()=>{
  it('does not require sunset developer tokens or mistake configured credentials for live acceptance',()=>{
    const report=googleAdsSetupReport(settings);
    expect(report).toMatchObject({configured:true,developerTokenRequired:false,liveVerified:false,productionAccess:'unverified',publishingEnabled:false,redirectUri:'https://ads.example.test/api/google-ads/oauth/callback'});
    const output=JSON.stringify(report);for(const value of [settings.GOOGLE_ADS_CLIENT_ID,settings.GOOGLE_ADS_CLIENT_SECRET,settings.GOOGLE_ADS_TOKEN_KEY])expect(output).not.toContain(value);
  });
  it('reports missing setting names without generating or replacing the encryption key',()=>{
    expect(googleAdsSetupReport({})).toMatchObject({configured:false,missing:['GOOGLE_ADS_CLIENT_ID','GOOGLE_ADS_CLIENT_SECRET','GOOGLE_ADS_TOKEN_KEY']});
  });
  it.each(['http://public.example','https://user:secret@example.org','https://example.org/subpath','https://example.org/?token=secret','https://example.org/#secret','https://example.org/','https://EXAMPLE.org','https://example.org:443'])('rejects unsafe or inconsistent OAuth origins: %s',WEB_ORIGIN=>{
    const report=googleAdsSetupReport({...settings,WEB_ORIGIN});expect(report.configured).toBe(false);expect(report.redirectUri).toBeNull();expect(report.invalid).toContain('WEB_ORIGIN');expect(JSON.stringify(report)).not.toContain(WEB_ORIGIN);
  });
  it('rejects malformed key and client id, while accepting an explicit loopback callback',()=>{
    expect(googleAdsSetupReport({...settings,GOOGLE_ADS_CLIENT_ID:'placeholder',GOOGLE_ADS_TOKEN_KEY:'short',WEB_ORIGIN:'http://127.0.0.1:3000'})).toMatchObject({configured:false,invalid:['GOOGLE_ADS_CLIENT_ID','GOOGLE_ADS_TOKEN_KEY'],redirectUri:'http://127.0.0.1:3000/api/google-ads/oauth/callback'});
  });
});
