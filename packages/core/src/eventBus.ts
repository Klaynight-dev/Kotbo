/**
 * Kotbo Internal Event Bus
 *
 * Phase 1: In-process EventEmitter - all modules run in the same process.
 *   Each module subscribes independently; if one fails, others are unaffected.
 *
 * Phase 2: Redis Pub/Sub transport - broadcast events across multiple bot
 *   processes, each running a subset of modules. Enable by calling
 *   `kotboEventBus.enableDistributed(publisherRedis, subscriberRedis)`.
 *
 * Usage:
 *   import { kotboEventBus } from '@kotbo/core';
 *   kotboEventBus.subscribe('message:new', async (payload) => { ... });
 *   kotboEventBus.publish('message:new', { guildId, channelId, ... });
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { currentCascadeDepth, runWithCascadeDepth } from './eventCascade.js';
import type { KotboEventMap, KotboEventName } from './eventBus.types.js';

export type KotboEventHandler<E extends KotboEventName> = (payload: KotboEventMap[E]) => void | Promise<void>;

interface SubscriptionMeta {
  module: string;
  event: KotboEventName;
}

interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', callback: (channel: string, message: string) => void): void;
}

class KotboEventBus {
  private emitter = new EventEmitter();
  private subscriptions: SubscriptionMeta[] = [];
  private subscribedRedisChannels = new Set<string>();

  // Phase 2 state
  private publisher: RedisLike | null = null;
  private subscriber: RedisLike | null = null;
  private distributed = false;
  private readonly instanceId = randomUUID();

  constructor() {
    this.emitter.setMaxListeners(80);
  }

  /**
   * Phase 2: Enable distributed mode with Redis Pub/Sub.
   * Pass two separate Redis/ioredis connections (subscriber can't be shared).
   */
  enableDistributed(publisher: RedisLike, subscriber: RedisLike): void {
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.distributed = true;

    this.subscriber.on('message', (channel: string, message: string) => {
      const event = channel.replace('kotbo:', '') as KotboEventName;
      try {
        const { payload, senderId, cascade } = JSON.parse(message);
        // Skip our own publishes echoed back by Redis - we already emitted
        // them locally and synchronously in publish(). Without this guard,
        // every bus event (welcome, boost, ...) fires twice on this process.
        if (senderId === this.instanceId) return;
        // La profondeur de cascade est retablie avant la livraison : sans elle
        // une chaine d'automatisations repartirait de zero a chaque saut de
        // processus, et sa borne ne l'arreterait jamais.
        runWithCascadeDepth(typeof cascade === 'number' ? cascade : 0, () => {
          this.emitter.emit(event, payload);
        });
      } catch { /* malformed message, skip */ }
    });

    // Subscribe to channels that were registered before distributed mode
    for (const channel of this.subscribedRedisChannels) {
      this.subscriber.subscribe(channel).catch(() => {});
    }
  }

  /**
   * Publish an event to all subscribed modules.
   * Errors in individual handlers are caught and logged - they never propagate
   * to the publisher or block other handlers.
   */
  publish<E extends KotboEventName>(event: E, payload: KotboEventMap[E]): void {
    // Local delivery
    this.emitter.emit(event, payload);

    // Distributed delivery via Redis Pub/Sub
    if (this.distributed && this.publisher) {
      const cascade = currentCascadeDepth();
      this.publisher
        .publish(`kotbo:${event}`, JSON.stringify({ payload, senderId: this.instanceId, cascade }))
        .catch(() => {});
    }
  }

  /**
   * Subscribe a module to an event.
   * The handler is wrapped with error isolation so one module crashing
   * never affects other subscribers.
   */
  subscribe<E extends KotboEventName>(
    event: E,
    handler: KotboEventHandler<E>,
    module?: string,
  ): void {
    const moduleName = module ?? 'unknown';

    const safeHandler = async (payload: KotboEventMap[E]) => {
      const key = Symbol.for('kotbo.guildContext');
      const storage = (globalThis as any)[key];
      const runWithContext = (cb: () => Promise<void>) => {
        if (storage && payload && typeof payload === 'object' && 'guildId' in payload && typeof (payload as any).guildId === 'string') {
          return storage.run({ guildId: (payload as any).guildId }, cb);
        }
        return cb();
      };

      try {
        await runWithContext(async () => {
          await handler(payload);
        });
      } catch (err) {
        console.error(`[KotboEventBus] Error in "${moduleName}" handler for "${event}":`, err);
      }
    };

    this.emitter.on(event, safeHandler as (...args: unknown[]) => void);
    this.subscriptions.push({ module: moduleName, event });

    // Track for distributed mode
    const channel = `kotbo:${event}`;
    if (!this.subscribedRedisChannels.has(channel)) {
      this.subscribedRedisChannels.add(channel);
      if (this.distributed && this.subscriber) {
        this.subscriber.subscribe(channel).catch(() => {});
      }
    }
  }

  /**
   * List all active subscriptions (useful for dashboard diagnostics).
   */
  getSubscriptions(): ReadonlyArray<SubscriptionMeta> {
    return this.subscriptions;
  }

  /**
   * Number of listeners for a given event.
   */
  listenerCount(event: KotboEventName): number {
    return this.emitter.listenerCount(event);
  }

  /**
   * Whether distributed mode is active.
   */
  isDistributed(): boolean {
    return this.distributed;
  }
}

export const kotboEventBus = new KotboEventBus();
