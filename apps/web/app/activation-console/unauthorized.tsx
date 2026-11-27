import { ActivationAccessMessage, ActivationFrame } from './activation-frame';

export default function Unauthorized() {
  return <ActivationFrame><ActivationAccessMessage kind="signin" /></ActivationFrame>;
}
