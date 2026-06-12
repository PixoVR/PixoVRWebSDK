/**
 * PixoVR Apex Web SDK
 *
 * A lightweight browser JavaScript library wrapping the Apex Platform API
 * endpoints used by the Apex Unity SDK. No dependencies, no build step —
 * usable as an ES module or via a <script type="module"> import.
 *
 * Supported calls:
 *   - login(username, password)
 *   - loginWithToken(token)
 *   - checkModuleAccess(moduleId, serialNumber)
 *   - joinSession(options)
 *   - completeSession(sessionData, options)
 *   - sendSimpleSessionEvent(action, targetObject, extensions)
 *   - sendSessionEvent(statement)
 *   - logout()
 *
 * Deep linking:
 *   - ApexClient.parseDeepLink(url) parses pixotoken / optional /
 *     returntarget / targettype arguments from a URL.
 *   - client.initFromDeepLink(url) parses the current page URL (or a
 *     provided one) and, if a pixotoken is present, logs in with it.
 */

const SDK_VERSION = '1.0.0';

export const ApexVerbs = {
  JOINED_SESSION: 'https://pixovr.com/xapi/verbs/joined_session',
  SESSION_EVENT: 'https://pixovr.com/xapi/verbs/session_event',
  COMPLETED_SESSION: 'https://pixovr.com/xapi/verbs/completed_session',
};

export const ApexEventTypes = {
  PIXOVR_SESSION_JOINED: 'PIXOVR_SESSION_JOINED',
  PIXOVR_SESSION_EVENT: 'PIXOVR_SESSION_EVENT',
  PIXOVR_SESSION_COMPLETE: 'PIXOVR_SESSION_COMPLETE',
};

const MODULE_ID_EXTENSION = 'https://pixovr.com/xapi/extension/moduleIds';
const EXTENSION_BASE = 'https://pixovr.com/xapi/extension/';

/**
 * Per-environment endpoints, mirroring PlatformEndpoints (modules API used
 * for login / access / events) and APIPlatformEndpoints (platform API used
 * for token validation) in the Unity SDK.
 */
export const ApexEnvironments = {
  'na-production': {
    modulesUrl: 'https://modules.apex.pixovr.com',
    apiUrl: 'https://apex.pixovr.com',
  },
  'na-stage': {
    modulesUrl: 'https://modules.apex.stage.pixovr.com',
    apiUrl: 'https://apex.stage.pixovr.com',
  },
  'na-dev': {
    modulesUrl: 'https://modules.apex.dev.pixovr.com',
    apiUrl: 'https://apex.dev.pixovr.com',
  },
  'sa-production': {
    modulesUrl: 'https://saudi.modules.apex.pixovr.com',
    apiUrl: 'https://saudi.apex.pixovr.com',
  },
  local: {
    modulesUrl: 'http://localhost:8001',
    apiUrl: 'http://localhost:8000',
  },
};

export class ApexError extends Error {
  constructor(message, { httpCode, response } = {}) {
    super(message);
    this.name = 'ApexError';
    this.httpCode = httpCode;
    this.response = response;
  }
}

function generateUuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Converts seconds to an ISO-8601 duration (e.g. 90 -> "PT1M30S"). */
function secondsToIsoDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  let out = 'PT';
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (s > 0 || out === 'PT') out += `${s}S`;
  return out;
}

/**
 * Builds an xAPI extensions object from a plain key/value map. Keys that are
 * not already absolute URIs are prefixed with the Pixo extension base URI,
 * mirroring Extension.AddSimple in the Unity SDK.
 */
function buildExtensions(simpleExtensions) {
  const result = {};
  if (!simpleExtensions) return result;
  for (const [key, value] of Object.entries(simpleExtensions)) {
    const uri = /^https?:\/\//i.test(key) ? key : EXTENSION_BASE + key;
    result[uri] = String(value);
  }
  return result;
}

const DEFAULT_STORAGE_KEY = 'pixovr-apex-session';

export class ApexClient {
  /**
   * @param {object} [options]
   * @param {string} [options.environment] One of the ApexEnvironments keys. Default 'na-production'.
   * @param {string} [options.modulesUrl]  Override the modules API base URL.
   * @param {string} [options.apiUrl]      Override the platform API base URL.
   * @param {number} [options.moduleId]    Default module ID for session calls.
   * @param {string} [options.scenarioId]  Default scenario ID for session calls.
   * @param {string} [options.moduleVersion] Module version reported in xAPI context.revision.
   * @param {string} [options.deviceId]    Device identifier sent with session events.
   * @param {Storage|null} [options.storage] Storage for session persistence. Defaults to
   *                                         window.localStorage; pass null to disable.
   * @param {string} [options.storageKey]  Storage key. Default 'pixovr-apex-session'.
   */
  constructor(options = {}) {
    const env = ApexEnvironments[options.environment || 'na-production'];
    if (!env && !(options.modulesUrl && options.apiUrl)) {
      throw new ApexError(`Unknown environment "${options.environment}". ` +
        `Valid values: ${Object.keys(ApexEnvironments).join(', ')}`);
    }

    this.modulesUrl = (options.modulesUrl || env.modulesUrl).replace(/\/+$/, '');
    this.apiUrl = (options.apiUrl || env.apiUrl).replace(/\/+$/, '');

    this.moduleId = options.moduleId ?? -1;
    this.scenarioId = options.scenarioId ?? '';
    this.moduleVersion = options.moduleVersion ?? '';
    this.deviceId = options.deviceId ?? 'web';
    this.platform = 'Web';

    this.storage = options.storage === undefined
      ? (typeof localStorage !== 'undefined' ? localStorage : null)
      : options.storage;
    this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;

    /** Current logged-in user (LoginResponseContent shape) or null. */
    this.user = null;
    /** Result of the last checkModuleAccess call, or null. */
    this.moduleAccess = null;
    /** UUID of the in-progress session, or null. */
    this.sessionUuid = null;
    /** Server-side session ID returned by joinSession, or null. */
    this.sessionId = null;
    this.sessionInProgress = false;

    this._restore();
  }

  // ---------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------

  get isLoggedIn() {
    return !!(this.user && this.user.Token);
  }

  get authToken() {
    return this.user ? this.user.Token : null;
  }

  _persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({
        user: this.user,
        moduleAccess: this.moduleAccess,
        sessionUuid: this.sessionUuid,
        sessionId: this.sessionId,
        sessionInProgress: this.sessionInProgress,
      }));
    } catch (e) {
      console.warn('[ApexClient] Failed to persist session state.', e);
    }
  }

  _restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      this.user = saved.user ?? null;
      this.moduleAccess = saved.moduleAccess ?? null;
      this.sessionUuid = saved.sessionUuid ?? null;
      this.sessionId = saved.sessionId ?? null;
      this.sessionInProgress = saved.sessionInProgress ?? false;
    } catch (e) {
      console.warn('[ApexClient] Failed to restore session state.', e);
    }
  }

  _requireLogin() {
    if (!this.isLoggedIn) {
      throw new ApexError('No active login. Call login() or loginWithToken() first.');
    }
  }

  async _request(baseUrl, path, { method = 'GET', body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApexError(`Network request failed: ${e.message}`);
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    const failed = !response.ok ||
      (data && typeof data === 'object' && typeof data.Error === 'string' &&
        data.Error.toLowerCase() === 'true');
    if (failed) {
      const message = (data && typeof data === 'object' && (data.Message || data.Error)) ||
        `Request to ${path} failed with status ${response.status}`;
      throw new ApexError(message, { httpCode: response.status, response: data });
    }

    return data;
  }

  // ---------------------------------------------------------------------
  // Deep linking
  // ---------------------------------------------------------------------

  /**
   * Parses Apex deep link arguments out of a URL. Recognizes the same
   * arguments the Unity SDK handles: pixotoken, optional, returntarget and
   * targettype, plus moduleid and scenarioid for web launches.
   *
   * @param {string} [url] URL to parse. Defaults to the current page URL.
   * @returns {{pixotoken?: string, optional?: string, returntarget?: string,
   *            targettype?: string, moduleid?: string, scenarioid?: string}}
   */
  static parseDeepLink(url) {
    const target = url ?? (typeof window !== 'undefined' ? window.location.href : '');
    const result = {};
    if (!target) return result;

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return result;
    }

    const collect = (params) => {
      for (const [key, value] of params.entries()) {
        result[key.toLowerCase()] = value;
      }
    };

    collect(parsed.searchParams);
    // Also support arguments passed in the URL fragment (e.g. #pixotoken=...).
    if (parsed.hash && parsed.hash.includes('=')) {
      collect(new URLSearchParams(parsed.hash.replace(/^#\/?/, '')));
    }

    return result;
  }

  /**
   * Parses deep link arguments from the given (or current page) URL, applies
   * moduleid/scenarioid if present, and logs in with the passed pixotoken.
   *
   * @param {string} [url]
   * @returns {Promise<{params: object, user: object|null}>} Parsed params and,
   *          if a token login occurred, the logged-in user.
   */
  async initFromDeepLink(url) {
    const params = ApexClient.parseDeepLink(url);

    if (params.moduleid !== undefined) {
      const moduleId = Number.parseInt(params.moduleid, 10);
      if (!Number.isNaN(moduleId)) this.moduleId = moduleId;
    }
    if (params.scenarioid !== undefined) {
      this.scenarioId = params.scenarioid;
    }

    let user = null;
    if (params.pixotoken) {
      user = await this.loginWithToken(params.pixotoken);
    }

    return { params, user };
  }

  // ---------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------

  /**
   * Logs in with a username/email and password.
   * POST {modulesUrl}/login
   *
   * @returns {Promise<object>} The logged-in user information.
   */
  async login(username, password) {
    const data = await this._request(this.modulesUrl, '/login', {
      method: 'POST',
      body: { Login: username, Password: password },
    });

    if (!data || !data.Token || !data.Email) {
      throw new ApexError('Login failed: invalid credentials or malformed response.', { response: data });
    }

    this.user = data;
    this._persist();
    return this.user;
  }

  /**
   * Logs in with an existing auth token (e.g. from a deep link).
   * GET {apiUrl}/v2/auth/validate-signature
   *
   * @returns {Promise<object>} The logged-in user information.
   */
  async loginWithToken(token) {
    const data = await this._request(this.apiUrl, '/v2/auth/validate-signature', { token });

    if (!data || !data.User) {
      throw new ApexError('Token login failed: token is invalid or expired.', { response: data });
    }

    this.user = { ...data.User, Token: data.User.Token || token };
    this._persist();
    return this.user;
  }

  /**
   * Invalidates all stored session information and clears the current user.
   */
  logout() {
    this.user = null;
    this.moduleAccess = null;
    this.sessionUuid = null;
    this.sessionId = null;
    this.sessionInProgress = false;
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey);
      } catch (e) {
        console.warn('[ApexClient] Failed to clear stored session state.', e);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Module access
  // ---------------------------------------------------------------------

  /**
   * Checks whether the current user has access to a module.
   * GET {modulesUrl}/access/user/{userId}/module/{moduleId}[?serial=...]
   *
   * @param {number} [moduleId] Module to check. Defaults to the client's moduleId.
   * @param {string} [serialNumber] Optional device serial number.
   * @returns {Promise<object>} Access information ({UserId, ModuleId, Access, PassingScore}).
   */
  async checkModuleAccess(moduleId, serialNumber) {
    this._requireLogin();

    const targetModuleId = moduleId ?? this.moduleId;
    if (targetModuleId == null || targetModuleId < 0) {
      throw new ApexError('No module ID provided to check access for.');
    }

    const serial = serialNumber ? `?serial=${encodeURIComponent(serialNumber)}` : '';
    const data = await this._request(
      this.modulesUrl,
      `/access/user/${this.user.ID}/module/${targetModuleId}${serial}`,
    );

    this.moduleAccess = data;
    this._persist();
    return data;
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  _standardContextExtensions(extensions) {
    return {
      [MODULE_ID_EXTENSION]: String(this.moduleId),
      ...buildExtensions({
        device_id: this.deviceId,
        device_model: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        sdk_version: `web-${SDK_VERSION}`,
        module_access_checked: this.moduleAccess ? 'true' : 'false',
      }),
      ...buildExtensions(extensions),
    };
  }

  _buildContext(extensions) {
    return {
      registration: this.sessionUuid,
      revision: this.moduleVersion,
      platform: this.platform,
      extensions: this._standardContextExtensions(extensions),
    };
  }

  /**
   * Starts a new session for the current user and module.
   * POST {modulesUrl}/event
   *
   * @param {object} [options]
   * @param {number} [options.moduleId]   Module ID; defaults to the client's moduleId.
   * @param {string} [options.scenarioId] Scenario ID; defaults to the client's scenarioId.
   * @param {object} [options.extensions] Extra xAPI context extensions (simple key/value map).
   * @returns {Promise<{sessionId: number, uuid: string}>}
   */
  async joinSession(options = {}) {
    this._requireLogin();

    if (options.moduleId !== undefined) this.moduleId = options.moduleId;
    if (options.scenarioId !== undefined) this.scenarioId = options.scenarioId;

    if (this.sessionInProgress) {
      console.warn('[ApexClient] A session is already in progress; starting a new one.');
    }

    this.sessionUuid = generateUuid();

    const statement = {
      actor: { mbox: this.user.Email, objectType: 'Agent' },
      verb: {
        id: ApexVerbs.JOINED_SESSION,
        display: { en: 'Joined Session' },
      },
      object: {
        id: `https://pixovr.com/xapi/objects/${this.moduleId}/${this.scenarioId}`,
        objectType: 'Activity',
      },
      context: this._buildContext(options.extensions),
      timestamp: new Date().toISOString(),
    };

    const data = await this._request(this.modulesUrl, '/event', {
      method: 'POST',
      token: this.authToken,
      body: {
        uuid: this.sessionUuid,
        eventType: ApexEventTypes.PIXOVR_SESSION_JOINED,
        moduleId: this.moduleId,
        deviceId: this.deviceId,
        jsonData: statement,
      },
    });

    this.sessionInProgress = true;
    this.sessionId = this._extractSessionId(data);
    this._persist();

    return { sessionId: this.sessionId, uuid: this.sessionUuid };
  }

  _extractSessionId(data) {
    const container = data && typeof data === 'object' ? (data.Data ?? data) : null;
    if (!container || typeof container !== 'object') return null;
    for (const key of Object.keys(container)) {
      if (key.toLowerCase() === 'sessionid') {
        const value = Number.parseInt(container[key], 10);
        return Number.isNaN(value) ? null : value;
      }
    }
    return null;
  }

  /**
   * Sends a simple session event built from an action and target object,
   * mirroring ApexSystem.SendSimpleSessionEvent.
   *
   * @param {string} action       Verb name, e.g. "Pushed Button".
   * @param {string} targetObject Object the action was performed on.
   * @param {object} [extensions] Extra xAPI context extensions (simple key/value map).
   */
  async sendSimpleSessionEvent(action, targetObject, extensions) {
    if (!action) {
      throw new ApexError('Action (verb name) is required for a simple session event.');
    }
    if (!targetObject) {
      throw new ApexError('Target object is required for a simple session event.');
    }

    const verbSlug = action.replaceAll(' ', '_').toLowerCase();
    const objectSlug = targetObject.replaceAll(' ', '_').toLowerCase();

    return this.sendSessionEvent({
      verb: {
        id: `https://pixovr.com/xapi/verbs/${verbSlug}`,
        display: { en: action },
      },
      object: {
        id: `https://pixovr.com/xapi/objects/${this.moduleId}/${this.scenarioId}/${objectSlug}`,
        objectType: 'Activity',
      },
      context: { extensions: buildExtensions(extensions) },
    });
  }

  /**
   * Sends a custom xAPI statement as a session event.
   * POST {modulesUrl}/event
   *
   * The statement must include a verb (with id) and an object (target). The
   * actor and standard context fields are filled in automatically.
   *
   * @param {object} statement xAPI statement ({verb, object, context?, result?, ...}).
   */
  async sendSessionEvent(statement) {
    this._requireLogin();

    if (!this.sessionInProgress) {
      throw new ApexError('No session in progress to send an event for. Call joinSession() first.');
    }
    if (!statement || !statement.verb || !statement.verb.id) {
      throw new ApexError('Statement verb (with id) is required.');
    }
    if (!statement.object || !statement.object.id) {
      throw new ApexError('Statement object (target) is required.');
    }

    const context = statement.context ?? {};
    const fullStatement = {
      ...statement,
      actor: { mbox: this.user.Email, objectType: 'Agent' },
      context: {
        ...context,
        registration: this.sessionUuid,
        revision: this.moduleVersion,
        platform: this.platform,
        extensions: this._standardContextExtensions(context.extensions),
      },
      timestamp: new Date().toISOString(),
    };

    return this._request(this.modulesUrl, '/event', {
      method: 'POST',
      token: this.authToken,
      body: {
        uuid: this.sessionUuid,
        eventType: ApexEventTypes.PIXOVR_SESSION_EVENT,
        moduleId: this.moduleId,
        deviceId: this.deviceId,
        jsonData: fullStatement,
      },
    });
  }

  /**
   * Completes the in-progress session, reporting scores and results.
   * POST {modulesUrl}/event
   *
   * @param {object} [sessionData]
   * @param {number} [sessionData.score]       Raw score.
   * @param {number} [sessionData.scoreMin]    Minimum possible score.
   * @param {number} [sessionData.scoreMax]    Maximum possible score.
   * @param {number} [sessionData.scoreScaled] Scaled score (0-100). Derived from
   *                                           score/scoreMax when omitted.
   * @param {number} [sessionData.duration]    Session duration in seconds.
   * @param {boolean} [sessionData.complete]   Whether the session was completed. Default true.
   * @param {boolean} [sessionData.success]    Whether the user passed. Default false.
   * @param {object} [options]
   * @param {object} [options.extensions]       Extra xAPI context extensions.
   * @param {object} [options.resultExtensions] Extra xAPI result extensions.
   */
  async completeSession(sessionData = {}, options = {}) {
    this._requireLogin();

    if (!this.sessionInProgress) {
      throw new ApexError('No session in progress to complete. Call joinSession() first.');
    }

    const score = sessionData.score ?? 0;
    const scoreMin = sessionData.scoreMin ?? 0;
    const scoreMax = sessionData.scoreMax ?? 0;
    const duration = sessionData.duration ?? 0;
    const complete = sessionData.complete ?? true;
    const success = sessionData.success ?? false;

    let scoreScaled = sessionData.scoreScaled ?? 0;
    if (scoreScaled <= 0 && score > 0 && scoreMax > 0) {
      scoreScaled = (score / scoreMax) * 100;
    }

    const result = {
      completion: complete,
      success,
      score: { min: scoreMin, max: scoreMax, raw: score, scaled: scoreScaled },
      duration: secondsToIsoDuration(duration),
    };
    if (options.resultExtensions) {
      result.extensions = buildExtensions(options.resultExtensions);
    }

    const statement = {
      actor: { mbox: this.user.Email, objectType: 'Agent' },
      verb: {
        id: ApexVerbs.COMPLETED_SESSION,
        display: { en: 'Completed Session' },
      },
      object: {
        id: `https://pixovr.com/xapi/objects/${this.moduleId}/${this.scenarioId}`,
        objectType: 'Activity',
      },
      context: this._buildContext(options.extensions),
      result,
      timestamp: new Date().toISOString(),
      score,
      scoreMin,
      scoreMax,
      scoreScaled,
      sessionDuration: duration,
      lessonStatus: success ? 'passed' : 'failed',
      moduleName: String(this.moduleId),
    };

    const data = await this._request(this.modulesUrl, '/event', {
      method: 'POST',
      token: this.authToken,
      body: {
        uuid: this.sessionUuid,
        eventType: ApexEventTypes.PIXOVR_SESSION_COMPLETE,
        moduleId: this.moduleId,
        deviceId: this.deviceId,
        jsonData: statement,
      },
    });

    this.sessionInProgress = false;
    this.sessionUuid = null;
    this.sessionId = null;
    this._persist();

    return data;
  }
}

export default ApexClient;
