import { connect, rawStorage, removeAll, supportsWebAuthn, supportsWAUserVerification } from '@lo-fi/local-vault';
import '@lo-fi/local-vault/adapter/idb';
import { removeLocalAccount } from '@lo-fi/local-data-lock';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { randomBytes } from '@noble/post-quantum/utils.js';

/**
 * Class for managing encryption and data storage.
 * Implements the Singleton pattern to ensure a single instance.
 * Added support for events via EventTarget.
 * Supports two separate vaults: one for PQ signing keys and one for chat data.
 */
export class EncryptionManagerV2 extends EventTarget {
  // Static property to store the single instance of the class
  static instance = null;

  // Private properties
  #pqVault = null;       // Vault for PQ signing keys
  #chatVault = null;     // Vault for chat data
  #vaults = [];          // Registry for all vaults (both types)
  #isAuth = false;       // Authorization state flag
  #rawStore = rawStorage('idb'); // Raw storage for registry and IDs
  #isProduction = false;

  // PQ-specific private properties
  #pqPublicKey = null;   // Uint8Array
  #pqSecretKey = null;   // Uint8Array — тільки в пам'яті після unlock
  #userHash = null;      // string (hex)

  /**
   * Private constructor to implement Singleton.
   * Use EncryptionManager.getInstance() to get the instance.
   */
  constructor(IS_PRODUCTION = false) {
    super();

    console.log('encryption manager created')

    if (EncryptionManagerV2.instance) {
      return EncryptionManagerV2.instance;
    }

    EncryptionManagerV2.instance = this;
    this.#isProduction = IS_PRODUCTION;
    this.getVaults();
  }

  /**
   * Static method to get the single instance of the class.
   * @returns {EncryptionManagerV2} - Instance of the EncryptionManager class.
   */
  static getInstance() {
    if (!EncryptionManagerV2.instance) {
      EncryptionManagerV2.instance = new EncryptionManagerV2();
    }

    console.log('instance', EncryptionManagerV2.instance)

    return EncryptionManagerV2.instance;
  }

  /**
   * Getter for accessing the authorization state.
   * @returns {boolean} - Authorization state (true or false).
   */
  get isAuth() {
    console.log('is auth', this.#isAuth)
    return this.#isAuth;
  }

  /**
   * Setter for updating the authorization state.
   * Automatically dispatches an authChange event when the value changes.
   * @param {boolean} value - New value for the authorization state.
   */
  set isAuth(value) {
    console.log('set is auth', value)

    if (this.#isAuth !== value) {
      // Check if the value has changed
      this.#isAuth = value;
      this.dispatchEvent(new CustomEvent('authChange', { detail: { isAuth: value } }));
    }
  }

  get pqPublicKey() { return this.#pqPublicKey ? bytesToHex(this.#pqPublicKey) : null; }

  get userHash() { return this.#userHash; }

  get isUnlockedForSigning() { return !!this.#pqSecretKey && this.#isAuth; }

  /**
   * Initializes the storage by connecting to existing vaults or creating new ones.
   */
  async initialize() {
    try {
      const pqVaultID = await this.getPqVaultID();

      const chatVaultID = await this.getChatVaultID();

      if (pqVaultID) {
        await this.connectToPqVault(pqVaultID);
      } else {
        await this.createPqSigningVault();
      }

      if (chatVaultID) {
        await this.connectToChatVault(chatVaultID);
      } else {
        await this.createChatDataVault();
      }
    } catch (error) {
      await this.handleError(error, 'Error during storage initialization');
    }
  }

  /**
   * Creates a new PQ signing vault and saves its ID.
   * Generates PQ keys and stores them in the vault.
   * @param {object} data - Optional data for vault creation (keyOptions, username, notes, avatar, address, etc.)
   */
  async createPqSigningVault(data = {}) {
    console.log('Creating PQ signing vault', this.#isProduction);

    // Generate PQ keys
    const seed = randomBytes(32);
    const { publicKey, secretKey } = ml_dsa87.keygen(seed);

    this.#pqPublicKey = publicKey;
    const prefixed = new Uint8Array([1, ...publicKey]);
    this.#userHash = bytesToHex(sha3_512(prefixed));

    if (this.#isProduction) {
      this.#pqVault = await connect({
        storageType: 'idb',
        addNewVault: true,
        keyOptions: {
          ...data.keyOptions,
          authenticatorSelection: {
            authenticatorAttachment: "cross-platform",
            userVerification: "preferred",
            residentKey: "preferred",
            requireResidentKey: false
          },

          timeout: 60000,
        },
      });
    } else {
      this.#pqVault = {
        id: this.#userHash.slice(0, 12),  // Test ID based on hash
      };
    }

    // Store PQ secret in vault (automatically encrypted)
    await this.#pqVault.set('pq-secret-key', secretKey);

    // Update registry
    this.#vaults.push({
      type: 'pq-signing',
      name: data.keyOptions?.username || 'Default',
      notes: data.notes || '',
      avatar: data.avatar || '',
      address: data.address || '',
      publicKey: bytesToHex(publicKey),
      vaultId: this.#pqVault.id,
      synced: false
    });

    const registryKey = this.#isProduction ? 'vaults-registry' : 'test-vaults-registry';
    await this.#rawStore.set(registryKey, this.#vaults);
    await this.savePqVaultID(this.#pqVault.id);

    console.log('Created a new PQ signing vault with ID:', this.#pqVault.id);
    this.dispatchEvent(new CustomEvent('pqKeysGenerated', { detail: { userHash: this.#userHash } }));
  }

  /**
   * Creates a new chat data vault and saves its ID.
   * @param {object} data - Optional data for vault creation (keyOptions, username, etc.)
   */
  async createChatDataVault(data = {}) {
    console.log('Creating chat data vault', this.#isProduction);

    if (this.#isProduction) {
      this.#chatVault = await connect({
        storageType: 'idb',
        addNewVault: true,
        keyOptions: {
          ...data.keyOptions,
          authenticatorSelection: {
            authenticatorAttachment: "cross-platform",
            userVerification: "preferred",
            residentKey: "preferred",
            requireResidentKey: false
          },
          timeout: 60000,
        },
      });
    } else {
      this.#chatVault = {
        id: 'test-chat-vault',  // Test ID
      };
    }

    // Update registry (optional for chat vault)
    this.#vaults.push({
      type: 'chat-data',
      name: data.keyOptions?.username || 'Default Chat',
      vaultId: this.#chatVault.id,
      synced: false
    });

    const registryKey = this.#isProduction ? 'vaults-registry' : 'test-vaults-registry';
    await this.#rawStore.set(registryKey, this.#vaults);
    await this.saveChatVaultID(this.#chatVault.id);

    this.isAuth = true;

    console.log('Created a new chat data vault with ID:', this.#chatVault.id);
  }

  /**
   * Connects to an existing PQ signing vault using its ID.
   * @param {string} vaultID - The vault identifier.
   */
  async connectToPqVault(vaultID) {
    try {
      console.log('Connecting to PQ signing vault', this.#isProduction);

      if (this.#isProduction) {
        this.#pqVault = await connect({
          vaultID,
          storageType: 'idb',
          keyOptions: {
            authenticatorSelection: {
              authenticatorAttachment: "cross-platform",
              userVerification: "preferred",
              residentKey: "preferred",
              requireResidentKey: false
            },
            timeout: 60000,
          },
        });
      } else {
        this.#pqVault = {
          id: vaultID,
        };
      }

      // After connect, load PQ secret
      this.#pqSecretKey = await this.#pqVault.get('pq-secret-key');
      if (!(this.#pqSecretKey instanceof Uint8Array)) {
        throw new Error('PQ secret key not found in vault');
      }

      // Load publicKey and userHash from registry
      const registry = await this.#rawStore.get(this.#isProduction ? 'vaults-registry' : 'test-vaults-registry');
      const current = registry?.find(v => v.vaultId === vaultID && v.type === 'pq-signing');
      if (current?.publicKey) {
        this.#pqPublicKey = hexToBytes(current.publicKey);
      }
      if (current?.userHash) {
        this.#userHash = current.userHash;
      }

      console.log('Connected to PQ signing vault:', vaultID);
      this.dispatchEvent(new CustomEvent('pqUnlocked'));
    } catch (error) {
      this.#pqSecretKey = null;
      console.log('PQ vault auth failed');
      throw error;
    }
  }

  /**
   * Connects to an existing chat data vault using its ID.
   * @param {string} vaultID - The vault identifier.
   */
  async connectToChatVault(vaultID) {
    try {
      console.log('Connecting to chat data vault', this.#isProduction);
      if (this.#isProduction) {
        this.#chatVault = await connect({
          vaultID,
          storageType: 'idb',
          keyOptions: {
            authenticatorSelection: {
              authenticatorAttachment: "cross-platform",
              userVerification: "preferred",
              residentKey: "preferred",
              requireResidentKey: false
            },
            timeout: 60000,
          },
        });
      } else {
        this.#chatVault = {
          id: vaultID,
        };
      }

      this.isAuth = true;

      console.log('Connected to chat data vault:', vaultID);
    } catch (error) {
      console.log('Chat vault auth failed');
      throw error;
    }
  }

  async disconnect() {
    if (this.#pqVault) {
      this.#pqSecretKey = null;  // Clear secret from memory
    }
    if (this.#chatVault) {
      // Any chat-specific cleanup
    }
    this.#pqVault = null;
    this.#chatVault = null;
    this.isAuth = false;
    this.dispatchEvent(new CustomEvent('pqLocked'));
  }

  async removeVault(id, type = 'pq-signing') {
    try {
      const vaults = this.#vaults.filter((item) => item.vaultId !== id);
      if (this.#isProduction) {
        const vaultData = await this.#rawStore.get(`local-vault-${id}`);
        const vault = type === 'pq-signing' ? this.#pqVault : this.#chatVault;
        await vault.clear();
        removeLocalAccount(vaultData.accountID);
      } else {
        await this.#rawStore.remove(`test-local-vault-${id}`);
      }
      this.#vaults = vaults;
      const registryKey = this.#isProduction ? 'vaults-registry' : 'test-vaults-registry';
      await this.#rawStore.set(registryKey, vaults);
      if (type === 'pq-signing') {
        this.#pqVault = null;
        await this.removePqVaultID();
      } else {
        this.#chatVault = null;
        await this.removeChatVaultID();
      }
      this.isAuth = false;
    } catch (error) {
      console.error('removeVault error', error);
    }
  }

  /**
   * Saves data to the chat vault.
   * @param {any} value - Data to save.
   */
  async setChatData(value) {
    try {
      if (this.#isProduction) {
        await this.#chatVault.set(this.#chatVault.id, value);
      } else {
        await this.#rawStore.set(`test-local-vault-${this.#chatVault.id}`, value);
      }
      return true;
    } catch (error) {
      await this.handleError(error, 'Error saving chat data');
    }
  }

  /**
   * Retrieves data from the chat vault.
   * @returns {Promise<any>} - Retrieved data.
   */
  async getChatData() {
    try {
      let data;
      if (this.#isProduction) {
        data = await this.#chatVault.get(this.#chatVault.id);
      } else {
        data = await this.#rawStore.get(`test-local-vault-${this.#chatVault.id}`);
      }
      return data;
    } catch (error) {
      await this.handleError(error, 'Error retrieving chat data');
    }
  }

  async getVaults() {
    try {
      let vaults;
      if (this.#isProduction) {
        vaults = await this.#rawStore.get('vaults-registry');
      } else {
        vaults = await this.#rawStore.get('test-vaults-registry');
      }
      this.#vaults = vaults || [];

      console.log('vaults', vaults)
      return this.#vaults;
    } catch (error) {
      this.handleError(error, 'no vaults');
      console.error(`getVaults error`, error);
      return [];
    }
  }

  async updateAccountInfoVault(accountInfo, vaultId = this.#pqVault?.id) {
    try {
      const registryKey = this.#isProduction ? 'vaults-registry' : 'test-vaults-registry';
      const vaults = await this.#rawStore.get(registryKey);
      const idx = vaults.findIndex((v) => v.vaultId === vaultId);
      if (idx > -1) {
        vaults[idx].name = accountInfo.name;
        vaults[idx].notes = accountInfo.notes;
        vaults[idx].avatar = accountInfo.avatar;
        await this.#rawStore.set(registryKey, vaults);
        this.#vaults = vaults;
      }
    } catch (error) {
      this.handleError(error, 'no vaults');
      console.error(`updateAccountInfoVault error`, error);
    }
  }

  async updateSyncedStatusVault(accountInfo, vaultId = this.#pqVault?.id) {
    try {
      const registryKey = this.#isProduction ? 'vaults-registry' : 'test-vaults-registry';
      const vaults = await this.#rawStore.get(registryKey);
      const idx = vaults.findIndex((v) => v.vaultId === vaultId);
      if (idx > -1) {
        vaults[idx].synced = accountInfo.synced;
        await this.#rawStore.set(registryKey, vaults);
        this.#vaults = vaults;
      }
    } catch (error) {
      this.handleError(error, 'no vaults');
      console.error(`updateSyncedStatusVault error`, error);
    }
  }

  async setCurrentUser(isSet, vaultId = this.#pqVault?.id) {
    console.log('set current user')

    try {
      const registryKey = this.#isProduction ? 'vaults-registry' : 'test-vaults-registry';
      const vaults = await this.#rawStore.get(registryKey);
      const updatedVaults = vaults.map((vault) => {
        const isCurrent = vault.vaultId === vaultId;
        return {
          ...vault,
          current: isCurrent && isSet,
        };
      });
      await this.#rawStore.set(registryKey, updatedVaults);
      this.#vaults = updatedVaults;
    } catch (error) {
      await this.handleError(error, 'Error setting current user');
    }
  }

  /**
   * Checks for the existence of a vault.
   * @param {string} type - 'pq-signing' or 'chat-data'
   * @returns {Promise<boolean>} - true if the vault exists, otherwise false.
   */
  async hasVault(type = 'pq-signing') {
    try {
      const vaultID = type === 'pq-signing' ? await this.getPqVaultID() : await this.getChatVaultID();
      return !!vaultID;
    } catch (error) {
      console.error('Error checking vault existence:', error);
      return false;
    }
  }

  /**
   * Clears a vault and removes its ID.
   * @param {string} type - 'pq-signing' or 'chat-data'
   */
  async clearVault(type = 'pq-signing') {
    try {
      const vault = type === 'pq-signing' ? this.#pqVault : this.#chatVault;
      if (vault) {
        await vault.clear();
      }
      if (type === 'pq-signing') {
        this.#pqVault = null;
        await this.removePqVaultID();
      } else {
        this.#chatVault = null;
        await this.removeChatVaultID();
      }
      console.log(`${type} vault cleared`);
    } catch (error) {
      console.error('Error clearing the vault:', error);
    }
  }

  /**
   * Retrieves the PQ vault ID from raw storage.
   * @returns {Promise<string|null>} - The vault ID or null if not found.
   */
  async getPqVaultID() {
    return await this.#rawStore.get('pq-vault-id');
  }

  /**
   * Saves the PQ vault ID to raw storage.
   * @param {string} id - The vault ID.
   */
  async savePqVaultID(id) {
    await this.#rawStore.set('pq-vault-id', id);
  }

  /**
   * Removes the PQ vault ID from raw storage.
   */
  async removePqVaultID() {
    await this.#rawStore.remove('pq-vault-id');
  }

  /**
   * Retrieves the chat vault ID from raw storage.
   * @returns {Promise<string|null>} - The vault ID or null if not found.
   */
  async getChatVaultID() {
    return await this.#rawStore.get('chat-vault-id');
  }

  /**
   * Saves the chat vault ID to raw storage.
   * @param {string} id - The vault ID.
   */
  async saveChatVaultID(id) {
    await this.#rawStore.set('chat-vault-id', id);
  }

  /**
   * Removes the chat vault ID from raw storage.
   */
  async removeChatVaultID() {
    await this.#rawStore.remove('chat-vault-id');
  }

  /**
   * Ensures the vaults are initialized if they haven't been already.
   */
  async ensureVaults() {
    if (!this.#pqVault || !this.#chatVault) {
      console.warn('Vaults not initialized. Initializing...');
      await this.initialize();
    }
  }

  /**
   * Handles errors that occur during storage operations.
   * @param {Error} error - The error object.
   * @param {string} message - The message to display.
   */
  async handleError(error, message) {
    this.isAuth = false; // Use the setter
    if (this.isCancelError(error)) {
      console.warn(`${message}: Operation canceled by user. Clearing the vault.`);
      await this.clearVault('pq-signing');
      await this.clearVault('chat-data');
    } else {
      console.error(`${message}:`, error);
    }
  }

  /**
   * Checks if an error resulted from a canceled operation.
   * @param {Error} error - The error object.
   * @returns {boolean} - true if the operation was canceled, otherwise false.
   */
  isCancelError(error) {
    return (
      error.message?.includes('The operation either timed out or was not allowed') ||
      error.message?.includes('Credential auth failed') ||
      error.message?.includes('Identity/Passkey registration failed') ||
      error.name === 'AbortError'
    );
  }

  /**
   * Signs a challenge using the PQ key (for Electric API).
   * @param {Uint8Array | string} challenge - The challenge to sign.
   * @returns {Promise<Uint8Array>} - The signature.
   */
  async signChallenge(challenge) {
    if (!this.#pqVault) {
      throw new Error('PQ vault not connected. Call connectToPqVault or createPqSigningVault first.');
    }

    if (!this.#pqSecretKey) {
      this.#pqSecretKey = await this.#pqVault.get('pq-secret-key');

      if (!(this.#pqSecretKey instanceof Uint8Array)) {
        throw new Error('PQ secret key not loaded.');
      }
    }

    let msg = challenge;

    if (typeof challenge === 'string') {
      // base64 від Electric → bytes
      msg = Uint8Array.from(atob(challenge), c => c.charCodeAt(0));
    }

    return ml_dsa87.sign(msg, this.#pqSecretKey);
  }
}