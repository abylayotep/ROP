import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
const proxyUrl = process.env.KASPI_POS_PROXY_URL || '';
const socks = proxyUrl ? new SocksProxyAgent(proxyUrl) : null;
// Internal service requests must remain inside the container network.
const agentFor = ({ hostname }) => socks && (hostname === 'kaspi.kz' || hostname.endsWith('.kaspi.kz')) ? socks : undefined;
export default function fetch(url, options = {}) {
  return nodeFetch(url, socks ? { ...options, agent: agentFor } : options);
}
