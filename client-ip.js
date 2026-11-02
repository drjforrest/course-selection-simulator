// Works out the visitor's IP for sign-in rate limiting.
//
// The app listens on localhost behind Caddy, so the rightmost X-Forwarded-For entry is the address
// Caddy itself saw. When that address belongs to Cloudflare (proxied DNS), the real visitor is in
// CF-Connecting-IP. That header is only trusted from Cloudflare, because anyone reaching the server
// directly could set it.

import net from 'node:net';

// https://www.cloudflare.com/ips-v4 and /ips-v6 (fetched November 2026).
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15',
  '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'];

const cloudflare = new net.BlockList();
for (const c of CLOUDFLARE_V4) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv4'); }
for (const c of CLOUDFLARE_V6) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv6'); }

const normalize = ip => (ip || '').trim().replace(/^::ffff:/, '');

export function isCloudflare(ip) {
  const v = net.isIP(ip);
  return v ? cloudflare.check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
}

export function clientIp(headers, socketAddress) {
  const forwarded = (headers['x-forwarded-for'] || '').split(',').map(normalize).filter(Boolean);
  const peer = forwarded.length ? forwarded[forwarded.length - 1] : normalize(socketAddress);
  const cf = normalize(headers['cf-connecting-ip']);
  return isCloudflare(peer) && net.isIP(cf) ? cf : peer;
}
