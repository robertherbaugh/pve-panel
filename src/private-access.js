import { zrokOverview } from './zrok-access.js';
import { config } from './config.js';
import { remoteAccessSettings } from './remote-access-settings.js';
import { tailscaleOverview } from './tailscale.js';
import { zitiOverview } from './openziti-access.js';
export function privateAccessOverview() {
  const selected = remoteAccessSettings(),
    connections = tailscaleOverview(),
    openziti = zitiOverview(), zrok = zrokOverview();
  const providers = [
    {
      id: 'openziti',
      name: 'OpenZiti',
      supported: true,
      enabled: openziti.settings.enabled,
      configured: openziti.settings.configured,
      health:
        openziti.services.some((s) => s.state === 'revoking') ||
        openziti.grants.some((g) => g.state === 'revoking')
          ? 'revocation_pending'
          : openziti.settings.checkError
            ? 'error'
            : openziti.settings.verifiedAt
              ? 'verified'
              : 'unchecked',
      detail:
        'Identity-based access to individual VM services. Dedicated RCADEA customer controller.',
      connections: openziti.services.length,
    },
    {
      id: 'headscale',
      name: 'Headscale',
      supported: true,
      enabled: config.tailscale.enabled && selected.provider === 'headscale',
      configured: selected.provider === 'headscale' && !!selected.loginServer,
      health: 'unchecked',
      detail:
        'Private VM access using the Tailscale client and your Headscale control server.',
      connections: connections.filter((c) => c.provider === 'headscale').length,
    },
    {
      id: 'tailscale',
      name: 'Tailscale',
      supported: true,
      enabled: config.tailscale.enabled && selected.provider === 'tailscale',
      configured: true,
      health: 'unchecked',
      detail: 'Customers enroll VMs into their own Tailscale network.',
      connections: connections.filter((c) => c.provider === 'tailscale').length,
    },
    {
      id: 'wireguard',
      name: 'WireGuard',
      supported: true,
      enabled: config.vpn.enabled,
      configured: !!(
        config.network.enabled &&
        config.vpn.gatewayVmid &&
        config.vpn.endpoint
      ),
      health: 'unchecked',
      detail:
        'Gateway VPN for customer private subnets. Requires the legacy customer network integration.',
      connections: null,
    },
    {
      id: 'zrok',
      name: 'zrok',
      supported: true,
      enabled: zrok.settings.enabled,
      configured: zrok.settings.configured,
      health: zrok.agents.some(a=>a.state==='revoking') || zrok.shares.some(s=>s.state==='revoking') ? 'revocation_pending' : zrok.settings.checkError ? 'error' : zrok.settings.verifiedAt ? 'verified' : 'unchecked',
      detail: 'Application sharing through your self-hosted zrok server. Public HTTPS and private TCP.',
      connections: zrok.shares.length,
    },
  ];
  return {
    providers,
    openziti,
    zrok,
    remote: selected,
    tailscaleRuntimeEnabled: config.tailscale.enabled,
    wireguard: {
      enabled: config.vpn.enabled,
      gatewayVmid: config.vpn.gatewayVmid,
      endpoint: config.vpn.endpoint,
      networksEnabled: config.network.enabled,
    },
    connections,
  };
}
