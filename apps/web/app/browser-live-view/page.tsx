import { DesktopBrowserLiveView } from "../../components/browser-live-host";
import theme from "../../components/browser-premium-tokens.module.css";
import styles from "./desktop-browser-live.module.css";

export default function BrowserLiveViewPage() {
  return <main className={`${theme.theme} ${styles.shell}`}><DesktopBrowserLiveView /></main>;
}
