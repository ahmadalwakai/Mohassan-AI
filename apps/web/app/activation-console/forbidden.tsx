import { ActivationAccessMessage, ActivationFrame } from './activation-frame';

export default function Forbidden() {
  return <ActivationFrame><ActivationAccessMessage kind="forbidden" /></ActivationFrame>;
}
