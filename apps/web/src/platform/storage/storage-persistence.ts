export type StoragePersistenceMode = 'persistent' | 'best-effort' | 'unsupported' | 'unknown';

/**
 * 数据实际躺在哪里。这决定了「没拿到持久化」到底意味着什么：
 * 浏览器里是几百个源抢一个配额池，随时可能被 LRU 淘汰；
 * 原生壳里是应用私有目录，系统不会自动清理，只有用户清除应用数据或卸载才会没。
 */
export type StorageContainer = 'browser' | 'native-app';

export interface StoragePersistenceState {
  mode: StoragePersistenceMode;
  container: StorageContainer;
  /** 浏览器是否提供 StorageManager 的持久化接口。 */
  supported: boolean;
  /** 是否已经向浏览器发起过申请（申请只需要一次，之后读状态即可）。 */
  requested: boolean;
  message: string | null;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export function detectStorageContainer(): StorageContainer {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  try {
    return capacitor?.isNativePlatform?.() ? 'native-app' : 'browser';
  } catch {
    return 'browser';
  }
}

/**
 * 申请持久化存储。
 *
 * 不申请的话，源里的数据处于 best-effort 模式：磁盘紧张时浏览器可以在不通知的情况下
 * 直接清掉整个数据库。对一个「数据完全保存在本地」的应用来说，这是必须堵上的缺口。
 *
 * 顺带解决配额问题：Firefox 对持久化的源不适用每个 eTLD+1 约 10 GiB 的 group limit。
 * Chrome 侧主要是免于回收，配额数字不一定变。
 *
 * 申请结果由浏览器决定，可能静默拒绝（取决于站点参与度等启发式），所以这里永远不抛错，
 * 只如实报告当前状态，让面板能把「持久化 / 尽力而为」直接摆给用户看。
 */
export class StoragePersistence {
  readonly #storage: StorageManager | undefined;
  readonly #detectContainer: () => StorageContainer;
  #state: Omit<StoragePersistenceState, 'container'>;
  #pending: Promise<StoragePersistenceState> | null = null;

  constructor(
    storage: StorageManager | undefined = globalThis.navigator?.storage,
    detectContainer: () => StorageContainer = detectStorageContainer,
  ) {
    this.#storage = storage;
    this.#detectContainer = detectContainer;
    const supported =
      typeof storage?.persist === 'function' && typeof storage?.persisted === 'function';
    this.#state = {
      mode: supported ? 'unknown' : 'unsupported',
      supported,
      requested: false,
      message: supported ? null : 'This browser does not expose persistent storage.',
    };
  }

  /**
   * 每次读取时重新判定容器：启动早期原生桥可能还没注入，
   * 缓存下来会让安卓端一直被当成普通浏览器。
   */
  get state(): StoragePersistenceState {
    return { ...this.#state, container: this.#detectContainer() };
  }

  /** 幂等：重复调用只会复用第一次的申请结果。 */
  ensure(): Promise<StoragePersistenceState> {
    if (!this.#state.supported) return Promise.resolve(this.state);
    this.#pending ??= this.#request();
    return this.#pending;
  }

  async #request(): Promise<StoragePersistenceState> {
    try {
      const alreadyPersisted = await this.#storage!.persisted();
      const persisted = alreadyPersisted || (await this.#storage!.persist());
      this.#state = {
        mode: persisted ? 'persistent' : 'best-effort',
        supported: true,
        requested: true,
        message: persisted
          ? null
          : // Android WebView 里这条路永远走不通：接口在，但没有可以授予的流程。
            'Persistent storage was not granted; data may be evicted when disk space runs low.',
      };
    } catch (error) {
      this.#state = {
        mode: 'unknown',
        supported: true,
        requested: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return this.state;
  }
}

export const storagePersistence = new StoragePersistence();
