import styles from "./agent-activity.module.css";

/** Decorative activity shapes; the surrounding text supplies the status. */
export function AgentActivity({ variant = "dots" }: { variant?: "dots" | "spinner" }) {
  return <span className={styles[variant]} aria-hidden="true">
    {variant === "dots" ? <><span /><span /><span /><span /></> : null}
  </span>;
}
