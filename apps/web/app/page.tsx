import { BrowserLiveProvider } from "../components/browser-live-host";
import { Workspace } from "../components/workspace";

export default function Page() {
  return <BrowserLiveProvider><Workspace /></BrowserLiveProvider>;
}
