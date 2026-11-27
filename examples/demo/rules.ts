// The host's governance policy, as rules over the graph. Aegis evaluates them; it has none of its own.
import type { Graph, Rule } from '../../packages/core/src/index.ts';

export const RULES: Rule[] = [
  {
    id: 'share-without-approval',
    title: 'Agents on external models are shared without approval',
    severity: 'high',
    fix: 'Require approval before an agent is shared.',
    closeWith: ['Approval required'],
    closeValue: true,
    check: (g: Graph) => {
      const rule = g.get('rule:agent.share');
      const open = g.ofType('Agent').filter((x) => x.props.shared && g.out(x.id, 'uses').some((m) => m.props.external));
      return rule && !rule.props.required && open.length ? ['rule:agent.share', ...open.map((x) => x.id)] : [];
    },
  },
  {
    id: 'shell-on-shared-agent',
    title: 'Shared agents can run shell commands',
    severity: 'medium',
    fix: 'Stop sharing agents that call the shell tool, or remove the tool.',
    closeWith: ['Shared'],
    closeValue: false,
    check: (g: Graph) => g.ofType('Agent').filter((x) => x.props.shared && g.out(x.id, 'calls').some((t) => t.title === 'shell')).map((x) => x.id),
  },
];
