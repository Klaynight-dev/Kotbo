import { describe, expect, test } from 'bun:test';
import type { WorkflowGraph } from '@kotbo/shared';
import { runWorkflow, type WorkflowEffects } from '../../services/features/workflow/engine';
import { coerceToString, type MemberValue, type RoleValue } from '../../services/features/workflow/values';

// ── Effets simulés ──────────────────────────────────────────────────────────
function makeEffects(overrides: Partial<WorkflowEffects> = {}) {
  const calls: { type: string; inputs: Record<string, unknown> }[] = [];

  const effects: WorkflowEffects = {
    getRole: async (roleId) => (roleId ? { kind: 'Role', id: roleId, name: `role-${roleId}` } : null),
    getChannel: async (channelId) =>
      channelId ? { kind: 'Channel', id: channelId, name: `salon-${channelId}`, categoryName: null } : null,
    getMember: async (userId) =>
      userId
        ? {
          kind: 'Member',
          id: userId,
          tag: `${userId}#0000`,
          displayName: `membre-${userId}`,
          isBot: false,
          roleIds: [],
          accountCreatedAt: null,
          joinedAt: null,
        }
        : null,
    getGuildInfo: async () => ({ name: 'Serveur test', memberCount: 42 }),
    runAction: async (type, inputs) => {
      calls.push({ type, inputs });
      return {};
    },
    ...overrides,
  };

  return { effects, calls };
}

const member: MemberValue = {
  kind: 'Member',
  id: 'u1',
  tag: 'Alice#0001',
  displayName: 'Alice',
  isBot: false,
  roleIds: ['r1', 'r2'],
  accountCreatedAt: Date.parse('2020-01-01'),
  joinedAt: Date.parse('2026-07-01'),
};

// ── Fabriques ───────────────────────────────────────────────────────────────
function node(id: string, type: string, config?: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, config };
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}
function graph(nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph {
  return { nodes, edges };
}

describe('runWorkflow - flux simple', () => {
  test('exécute une action reliée au déclencheur', async () => {
    const { effects, calls } = makeEffects();
    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('r', 'SelectRole', { roleId: 'r9' }), node('a', 'AddRole')],
        [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('r', 'role', 'a', 'role')],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(result.status).toBe('COMPLETED');
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('AddRole');
    expect((calls[0].inputs.role as RoleValue).id).toBe('r9');
    expect((calls[0].inputs.member as MemberValue).id).toBe('u1');
  });

  test('échoue proprement quand le graphe n\'a pas de déclencheur', async () => {
    const { effects } = makeEffects();
    const result = await runWorkflow({
      graph: graph([node('a', 'AddRole')], []),
      effects,
    });
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.error).toContain('déclencheur');
  });

  test('se termine sans rien faire si le déclencheur n\'est relié à rien', async () => {
    const { effects, calls } = makeEffects();
    const result = await runWorkflow({
      graph: graph([node('t', 'OnMemberJoin')], []),
      effects,
      triggerOutputs: { member },
    });
    expect(result.status).toBe('COMPLETED');
    expect(calls).toHaveLength(0);
  });

  test('enchaîne plusieurs actions dans l\'ordre du câblage', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: graph(
        [
          node('t', 'OnMemberJoin'),
          node('r', 'SelectRole', { roleId: 'r9' }),
          node('a1', 'AddRole'),
          node('a2', 'RemoveRole'),
        ],
        [
          edge('t', 'next', 'a1', 'exec'),
          edge('a1', 'next', 'a2', 'exec'),
          edge('t', 'member', 'a1', 'member'), edge('r', 'role', 'a1', 'role'),
          edge('t', 'member', 'a2', 'member'), edge('r', 'role', 'a2', 'role'),
        ],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(calls.map((c) => c.type)).toEqual(['AddRole', 'RemoveRole']);
  });
});

describe('runWorkflow - évaluation des données', () => {
  test('n\'évalue que les nœuds de données réellement utilisés', async () => {
    let roleLookups = 0;
    const { effects, calls } = makeEffects({
      getRole: async (id) => { roleLookups++; return { kind: 'Role', id, name: `role-${id}` }; },
    });

    await runWorkflow({
      graph: graph(
        [
          node('t', 'OnMemberJoin'),
          node('utile', 'SelectRole', { roleId: 'r1' }),
          node('inutile', 'SelectRole', { roleId: 'r2' }),
          node('a', 'AddRole'),
        ],
        [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('utile', 'role', 'a', 'role')],
      ),
      effects,
      triggerOutputs: { member },
    });

    // Le sélecteur non branché ne doit jamais être interrogé
    expect(roleLookups).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('convertit implicitement un membre en texte', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('c', 'SelectChannel', { channelId: 'c1' }), node('s', 'SendMessage')],
        [edge('t', 'next', 's', 'exec'), edge('c', 'channel', 's', 'channel'), edge('t', 'member', 's', 'text')],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(calls[0].inputs.text).toBe('Alice');
  });

  test('assemble un texte avec les infos du membre', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: graph(
        [
          node('t', 'OnMemberJoin'),
          node('info', 'MemberInfo'),
          node('bonjour', 'ConstText', { value: 'Bienvenue' }),
          node('cat', 'Concat', { separator: ' ' }),
          node('c', 'SelectChannel', { channelId: 'c1' }),
          node('s', 'SendMessage'),
        ],
        [
          edge('t', 'next', 's', 'exec'),
          edge('t', 'member', 'info', 'member'),
          edge('bonjour', 'value', 'cat', 'a'),
          edge('info', 'displayName', 'cat', 'b'),
          edge('cat', 'result', 's', 'text'),
          edge('c', 'channel', 's', 'channel'),
        ],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(calls[0].inputs.text).toBe('Bienvenue Alice');
  });

  test('utilise la configuration quand aucun fil n\'alimente l\'entrée', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('c', 'SelectChannel', { channelId: 'c1' }), node('s', 'SendMessage', { text: 'valeur fixe' })],
        [edge('t', 'next', 's', 'exec'), edge('c', 'channel', 's', 'channel')],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(calls[0].inputs.text).toBe('valeur fixe');
  });
});

describe('runWorkflow - contrôle de flux', () => {
  function branchGraph(): WorkflowGraph {
    return graph(
      [
        node('t', 'OnMemberJoin'),
        node('r', 'SelectRole', { roleId: 'r1' }),
        node('has', 'HasRole'),
        node('if', 'If'),
        node('siVrai', 'AddRole'),
        node('siFaux', 'KickMember'),
      ],
      [
        edge('t', 'next', 'if', 'exec'),
        edge('t', 'member', 'has', 'member'),
        edge('r', 'role', 'has', 'role'),
        edge('has', 'result', 'if', 'condition'),
        edge('if', 'true', 'siVrai', 'exec'),
        edge('if', 'false', 'siFaux', 'exec'),
        edge('t', 'member', 'siVrai', 'member'), edge('r', 'role', 'siVrai', 'role'),
        edge('t', 'member', 'siFaux', 'member'),
      ],
    );
  }

  test('suit la branche Vrai quand le membre possède le rôle', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({ graph: branchGraph(), effects, triggerOutputs: { member } });
    expect(calls.map((c) => c.type)).toEqual(['AddRole']);
  });

  test('suit la branche Faux sinon', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: branchGraph(),
      effects,
      triggerOutputs: { member: { ...member, roleIds: ['autre'] } },
    });
    expect(calls.map((c) => c.type)).toEqual(['KickMember']);
  });

  test('aiguille vers le cas correspondant du Switch', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: graph(
        [
          node('t', 'OnSanctionApplied'),
          node('sw', 'Switch', { cases: ['warn', 'ban'] }),
          node('aWarn', 'SendDM'),
          node('aBan', 'KickMember'),
          node('txt', 'ConstText', { value: 'coucou' }),
        ],
        [
          edge('t', 'next', 'sw', 'exec'),
          edge('t', 'type', 'sw', 'value'),
          edge('sw', 'case-1', 'aBan', 'exec'),
          edge('sw', 'case-0', 'aWarn', 'exec'),
          edge('t', 'member', 'aWarn', 'member'), edge('txt', 'value', 'aWarn', 'text'),
          edge('t', 'member', 'aBan', 'member'),
        ],
      ),
      effects,
      triggerOutputs: { member, type: 'ban' },
    });

    expect(calls.map((c) => c.type)).toEqual(['KickMember']);
  });

  test('emprunte la sortie Sinon quand aucun cas ne correspond', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: graph(
        [
          node('t', 'OnSanctionApplied'),
          node('sw', 'Switch', { cases: ['warn'] }),
          node('def', 'KickMember'),
        ],
        [
          edge('t', 'next', 'sw', 'exec'),
          edge('t', 'type', 'sw', 'value'),
          edge('sw', 'default', 'def', 'exec'),
          edge('t', 'member', 'def', 'member'),
        ],
      ),
      effects,
      triggerOutputs: { member, type: 'inconnu' },
    });

    expect(calls.map((c) => c.type)).toEqual(['KickMember']);
  });
});

describe('runWorkflow - boucles', () => {
  function loopGraph(): WorkflowGraph {
    return graph(
      [
        node('t', 'OnMemberJoin'),
        node('info', 'MemberInfo'),
        node('loop', 'ForEach'),
        node('rm', 'RemoveRole'),
        node('fin', 'SendDM'),
        node('txt', 'ConstText', { value: 'terminé' }),
      ],
      [
        edge('t', 'next', 'loop', 'exec'),
        edge('t', 'member', 'info', 'member'),
        edge('info', 'roles', 'loop', 'list'),
        edge('loop', 'body', 'rm', 'exec'),
        edge('loop', 'item', 'rm', 'role'),
        edge('t', 'member', 'rm', 'member'),
        edge('loop', 'done', 'fin', 'exec'),
        edge('t', 'member', 'fin', 'member'),
        edge('txt', 'value', 'fin', 'text'),
      ],
    );
  }

  test('exécute le corps une fois par élément puis suit la sortie Terminé', async () => {
    const { effects, calls } = makeEffects();
    const result = await runWorkflow({ graph: loopGraph(), effects, triggerOutputs: { member } });

    expect(result.status).toBe('COMPLETED');
    // Deux rôles sur le membre → deux retraits, puis le message final
    expect(calls.map((c) => c.type)).toEqual(['RemoveRole', 'RemoveRole', 'SendDM']);
  });

  test('passe un élément différent à chaque itération', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({ graph: loopGraph(), effects, triggerOutputs: { member } });

    const roles = calls.filter((c) => c.type === 'RemoveRole').map((c) => (c.inputs.role as RoleValue).id);
    expect(roles).toEqual(['r1', 'r2']);
  });

  test('saute directement à Terminé sur une liste vide', async () => {
    const { effects, calls } = makeEffects();
    await runWorkflow({
      graph: loopGraph(),
      effects,
      triggerOutputs: { member: { ...member, roleIds: [] } },
    });
    expect(calls.map((c) => c.type)).toEqual(['SendDM']);
  });
});

describe('runWorkflow - garde-fous', () => {
  test('interrompt une liste dépassant le plafond d\'itérations', async () => {
    const { effects } = makeEffects();
    const bigList = Array.from({ length: 50 }, (_, i) => `r${i}`);

    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('info', 'MemberInfo'), node('loop', 'ForEach'), node('rm', 'RemoveRole')],
        [
          edge('t', 'next', 'loop', 'exec'),
          edge('t', 'member', 'info', 'member'),
          edge('info', 'roles', 'loop', 'list'),
          edge('loop', 'body', 'rm', 'exec'),
          edge('loop', 'item', 'rm', 'role'),
          edge('t', 'member', 'rm', 'member'),
        ],
      ),
      effects,
      triggerOutputs: { member: { ...member, roleIds: bigList } },
      budget: { maxNodes: 20, maxNodeVisits: 200, maxIterations: 10, maxDurationMs: 15_000, maxLoopDepth: 4 },
    });

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.error).toContain('limite');
  });

  test('interrompt une exécution qui traverse trop de nœuds', async () => {
    const { effects } = makeEffects();
    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('info', 'MemberInfo'), node('loop', 'ForEach'), node('rm', 'RemoveRole')],
        [
          edge('t', 'next', 'loop', 'exec'),
          edge('t', 'member', 'info', 'member'),
          edge('info', 'roles', 'loop', 'list'),
          edge('loop', 'body', 'rm', 'exec'),
          edge('loop', 'item', 'rm', 'role'),
          edge('t', 'member', 'rm', 'member'),
        ],
      ),
      effects,
      triggerOutputs: { member: { ...member, roleIds: Array.from({ length: 30 }, (_, i) => `r${i}`) } },
      budget: { maxNodes: 20, maxNodeVisits: 5, maxIterations: 500, maxDurationMs: 15_000, maxLoopDepth: 4 },
    });

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.error).toContain('nœuds parcourus');
  });

  test('interrompt une exécution trop longue', async () => {
    const { effects } = makeEffects();
    let clock = 0;
    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('r', 'SelectRole', { roleId: 'r1' }), node('a', 'AddRole')],
        [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('r', 'role', 'a', 'role')],
      ),
      effects,
      triggerOutputs: { member },
      // L'horloge bondit au-delà du budget dès le premier contrôle
      now: () => (clock += 20_000),
    });

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.error).toContain('ms');
  });

  test('remonte l\'échec d\'une action sans planter le moteur', async () => {
    const { effects } = makeEffects({
      runAction: async () => { throw new Error('Permissions insuffisantes'); },
    });

    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('r', 'SelectRole', { roleId: 'r1' }), node('a', 'AddRole')],
        [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('r', 'role', 'a', 'role')],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.error).toContain('Permissions');
  });
});

describe('runWorkflow - suspension et reprise', () => {
  function delayGraph(): WorkflowGraph {
    return graph(
      [
        node('t', 'OnMemberJoin'),
        node('r', 'SelectRole', { roleId: 'r9' }),
        node('avant', 'AddRole'),
        node('wait', 'Delay', { seconds: 3600 }),
        node('apres', 'RemoveRole'),
      ],
      [
        edge('t', 'next', 'avant', 'exec'),
        edge('avant', 'next', 'wait', 'exec'),
        edge('wait', 'next', 'apres', 'exec'),
        edge('t', 'member', 'avant', 'member'), edge('r', 'role', 'avant', 'role'),
        edge('t', 'member', 'apres', 'member'), edge('r', 'role', 'apres', 'role'),
      ],
    );
  }

  test('suspend l\'exécution sur un nœud Attendre', async () => {
    const { effects, calls } = makeEffects();
    const result = await runWorkflow({ graph: delayGraph(), effects, triggerOutputs: { member } });

    expect(result.status).toBe('SUSPENDED');
    expect(calls.map((c) => c.type)).toEqual(['AddRole']);
    if (result.status === 'SUSPENDED') {
      expect(result.resumeAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test('reprend là où elle s\'était arrêtée', async () => {
    const { effects, calls } = makeEffects();
    const suspended = await runWorkflow({ graph: delayGraph(), effects, triggerOutputs: { member } });
    expect(suspended.status).toBe('SUSPENDED');

    const resumed = await runWorkflow({
      graph: delayGraph(),
      effects,
      state: suspended.state,
    });

    expect(resumed.status).toBe('COMPLETED');
    expect(calls.map((c) => c.type)).toEqual(['AddRole', 'RemoveRole']);
  });

  test('l\'état de reprise survit à une sérialisation JSON', async () => {
    const { effects, calls } = makeEffects();
    const suspended = await runWorkflow({ graph: delayGraph(), effects, triggerOutputs: { member } });

    // C'est exactement ce que fait la persistance en base
    const roundTripped = JSON.parse(JSON.stringify(suspended.state));

    const resumed = await runWorkflow({ graph: delayGraph(), effects, state: roundTripped });
    expect(resumed.status).toBe('COMPLETED');
    expect(calls.map((c) => c.type)).toEqual(['AddRole', 'RemoveRole']);
  });

  test('reprend correctement une attente située au milieu d\'une boucle', async () => {
    const { effects, calls } = makeEffects();
    const g = graph(
      [
        node('t', 'OnMemberJoin'),
        node('info', 'MemberInfo'),
        node('loop', 'ForEach'),
        node('rm', 'RemoveRole'),
        node('wait', 'Delay', { seconds: 60 }),
      ],
      [
        edge('t', 'next', 'loop', 'exec'),
        edge('t', 'member', 'info', 'member'),
        edge('info', 'roles', 'loop', 'list'),
        edge('loop', 'body', 'rm', 'exec'),
        edge('rm', 'next', 'wait', 'exec'),
        edge('loop', 'item', 'rm', 'role'),
        edge('t', 'member', 'rm', 'member'),
      ],
    );

    // Première itération : un retrait puis suspension
    let result = await runWorkflow({ graph: g, effects, triggerOutputs: { member } });
    expect(result.status).toBe('SUSPENDED');
    expect(calls).toHaveLength(1);

    // Reprise : deuxième itération, puis suspension à nouveau
    result = await runWorkflow({ graph: g, effects, state: JSON.parse(JSON.stringify(result.state)) });
    expect(result.status).toBe('SUSPENDED');
    expect(calls).toHaveLength(2);

    // Dernière reprise : la liste est épuisée, l'exécution se termine
    result = await runWorkflow({ graph: g, effects, state: JSON.parse(JSON.stringify(result.state)) });
    expect(result.status).toBe('COMPLETED');
    expect(calls.map((c) => (c.inputs.role as RoleValue).id)).toEqual(['r1', 'r2']);
  });
});

describe('runWorkflow - journal d\'exécution', () => {
  test('consigne chaque nœud traversé avec ses entrées et sorties', async () => {
    const { effects } = makeEffects();
    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('r', 'SelectRole', { roleId: 'r9' }), node('a', 'AddRole')],
        [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('r', 'role', 'a', 'role')],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].nodeType).toBe('AddRole');
    expect(result.steps[0].status).toBe('OK');
    expect((result.steps[0].inputs.member as MemberValue).tag).toBe('Alice#0001');
  });

  test('note la branche empruntée par un nœud Si', async () => {
    const { effects } = makeEffects();
    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('b', 'ConstBoolean', { value: true }), node('if', 'If')],
        [edge('t', 'next', 'if', 'exec'), edge('b', 'value', 'if', 'condition')],
      ),
      effects,
      triggerOutputs: { member },
    });

    const ifStep = result.steps.find((s) => s.nodeType === 'If');
    expect(ifStep?.outputs.branche).toBe('Vrai');
  });

  test('marque en erreur l\'étape qui a échoué', async () => {
    const { effects } = makeEffects({
      runAction: async () => { throw new Error('boum'); },
    });
    const result = await runWorkflow({
      graph: graph(
        [node('t', 'OnMemberJoin'), node('r', 'SelectRole', { roleId: 'r1' }), node('a', 'AddRole')],
        [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('r', 'role', 'a', 'role')],
      ),
      effects,
      triggerOutputs: { member },
    });

    expect(result.status).toBe('FAILED');
  });
});

describe('coerceToString', () => {
  test('rend chaque entité sous une forme lisible', () => {
    expect(coerceToString(member)).toBe('Alice');
    expect(coerceToString({ kind: 'Role', id: 'r', name: 'Modérateur' })).toBe('Modérateur');
    expect(coerceToString(['a', 'b'])).toBe('a, b');
    expect(coerceToString(42)).toBe('42');
    expect(coerceToString(null)).toBe('');
  });
});
