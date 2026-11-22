/** Shared tests can import presentation helpers from a component with CSS modules. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
