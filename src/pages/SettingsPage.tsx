/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Layers,
  Loader2,
  Mic,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  DefaultStudioPreferences,
  FishAudioSettingsSummary,
  Project,
  SUPPORTED_LANGUAGES,
  StudioPreset,
  SupportedLanguage,
  SystemStatus,
  SyncMode,
} from '../types/studio';
import { api } from '../lib/api';
import { getStoredFishApiKey } from '../lib/fishAudioKeyManager';
import { normalizeFishApiKey } from '../lib/fishReference';
import { formatBytes } from '../lib/formatters';
import { MyVoicesManager } from '../components/MyVoicesManager';
import { MyStylesManager } from '../components/MyStylesManager';
import { StudioCard, StudioSectionHeader } from '../components/ui/StudioPrimitives';

export type SettingsTabId = 'api' | 'preferences' | 'storage' | 'voices' | 'styles';

interface SettingsPageProps {
  activeProject?: Project | null;
  onProjectUpdated?: (p: Project) => void;
  onOpenBackupModal?: () => void;
  onSettingsUpdated?: () => void;
  initialTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
  onOpenSaveStyleDialog?: () => void;
  onNotice?: (msg: string) => void;
}

const TABS: Array<{
  id: SettingsTabId;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'api', label: 'API & Engines', Icon: KeyRound },
  { id: 'preferences', label: 'Studio Defaults', Icon: SlidersHorizontal },
  { id: 'storage', label: 'Storage & Backups', Icon: HardDrive },
  { id: 'voices', label: 'Saved Voices', Icon: Mic },
  { id: 'styles', label: 'Saved Styles', Icon: Layers },
];

export function SettingsPage({
  activeProject,
  onProjectUpdated,
  onOpenBackupModal,
  onSettingsUpdated,
  initialTab = 'api',
  onTabChange,
  onOpenSaveStyleDialog,
  onNotice,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [fishSettings, setFishSettings] = useState<FishAudioSettingsSummary | null>(null);
  const [storageUsage, setStorageUsage] = useState<{
    totalBytes: number;
    buckets: Record<string, { bytes: number; files: number }>;
  } | null>(null);

  // Fish Audio API key state
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [revealedSavedKey, setRevealedSavedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);
  const [fishNotice, setFishNotice] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  // Default preferences state
  const [prefs, setPrefs] = useState<DefaultStudioPreferences | null>(null);
  const [styles, setStyles] = useState<StudioPreset[]>([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsMsg, setPrefsMsg] = useState<string | null>(null);

  // Cleanup state
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

  const refreshSettingsData = useCallback(async () => {
    const [sysRes, fishRes, prefRes, stylesRes, storRes] = await Promise.all([
      api.getSystemStatus().catch(() => null),
      api.getFishAudioSettings().catch(() => null),
      api.getDefaultPreferences().catch(() => null),
      api.listStyles().catch(() => null),
      api.getLocalStorageUsage().catch(() => null),
    ]);
    if (sysRes) setStatus(sysRes);
    if (fishRes) {
      setFishSettings(fishRes);
      if (!fishRes.configured) {
        setEditingKey(true);
      }
    }
    if (prefRes?.preferences) setPrefs(prefRes.preferences);
    if (stylesRes?.styles) setStyles(stylesRes.styles);
    if (storRes) setStorageUsage(storRes);
  }, []);

  useEffect(() => {
    void refreshSettingsData();
    return () => {
      setRevealedSavedKey(null);
    };
  }, [refreshSettingsData]);

  const handleToggleRevealSavedKey = async () => {
    if (revealedSavedKey !== null) {
      setRevealedSavedKey(null);
      return;
    }
    const stored = await getStoredFishApiKey();
    if (stored) {
      setRevealedSavedKey(stored);
    }
  };

  const handleToggleEditKey = async () => {
    if (editingKey) {
      setEditingKey(false);
      setApiKeyInput('');
      setShowKeyInput(false);
      return;
    }
    const stored = await getStoredFishApiKey();
    setApiKeyInput(stored || '');
    setShowKeyInput(false);
    setEditingKey(true);
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normalizeFishApiKey(apiKeyInput);
    if (!cleaned) {
      setFishNotice({ kind: 'error', text: 'Enter your Fish Audio API key first.' });
      return;
    }

    setSavingKey(true);
    setFishNotice(null);
    try {
      const savedSummary = await api.saveFishApiKey(cleaned);
      setFishSettings(savedSummary);
      setApiKeyInput('');
      setShowKeyInput(false);
      setRevealedSavedKey(null);
      setEditingKey(false);

      // Immediately verify the saved key from IndexedDB using minimal POST /v1/tts (s2.1-pro-free, no reference_id)
      setTestingConn(true);
      const testResult = await api.testFishAudioConnection();
      setFishSettings(testResult.settings);
      setFishNotice({
        kind: testResult.ok ? 'success' : 'error',
        text: testResult.ok
          ? `Saved locally in IndexedDB and verified with Fish Audio TTS (s2.1-pro-free).`
          : `Saved locally in IndexedDB, but verification failed: ${testResult.message}`,
      });
      await api.getSystemStatus().then(setStatus).catch(() => {});
      onSettingsUpdated?.();
    } catch (err) {
      setFishNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to save Fish Audio API key.',
      });
    } finally {
      setSavingKey(false);
      setTestingConn(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setFishNotice(null);
    try {
      const typedCandidate =
        editingKey && normalizeFishApiKey(apiKeyInput)
          ? normalizeFishApiKey(apiKeyInput)
          : undefined;
      const result = await api.testFishAudioConnection(typedCandidate);
      setFishSettings(result.settings);
      setFishNotice({
        kind: result.ok ? 'success' : 'error',
        text: result.message,
      });
      await api.getSystemStatus().then(setStatus).catch(() => {});
    } catch (err) {
      setFishNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTestingConn(false);
    }
  };

  const handleClearAndReenterKey = async () => {
    setRemovingKey(true);
    setFishNotice(null);
    try {
      const updated = await api.deleteFishApiKey();
      setFishSettings(updated);
      setApiKeyInput('');
      setShowKeyInput(false);
      setRevealedSavedKey(null);
      setEditingKey(true);
      await api.getSystemStatus().then(setStatus).catch(() => {});
      onSettingsUpdated?.();
      setTimeout(() => apiKeyInputRef.current?.focus(), 0);
    } catch (err) {
      setFishNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to clear API key.',
      });
    } finally {
      setRemovingKey(false);
    }
  };

  const handleRemoveSavedKey = async () => {
    setRemovingKey(true);
    setFishNotice(null);
    try {
      const updated = await api.deleteFishApiKey();
      setFishSettings(updated);
      setApiKeyInput('');
      setShowKeyInput(false);
      setRevealedSavedKey(null);
      setEditingKey(!updated.configured);
      setFishNotice({
        kind: 'success',
        text: updated.configured
          ? 'Removed saved local key; using fallback key.'
          : 'Removed Fish Audio API key from local browser storage.',
      });
      await api.getSystemStatus().then(setStatus).catch(() => {});
      onSettingsUpdated?.();
    } catch (err) {
      setFishNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to remove saved API key.',
      });
    } finally {
      setRemovingKey(false);
    }
  };

  const handleUpdatePreferences = async (patch: Partial<DefaultStudioPreferences>) => {
    setSavingPrefs(true);
    setPrefsMsg(null);
    try {
      const res = await api.updateDefaultPreferences(patch);
      setPrefs(res.preferences);
      setPrefsMsg('Default studio preferences saved.');
      onNotice?.('Default studio preferences updated.');
    } catch (err) {
      setPrefsMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanupMsg(null);
    try {
      const res = await api.runCleanup();
      setCleanupMsg(`Cleanup complete: ${res.removedFiles} expired temporary items removed.`);
      const storRes = await api.getLocalStorageUsage().catch(() => null);
      if (storRes) setStorageUsage(storRes);
    } catch (err) {
      setCleanupMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  const connStatus = fishSettings?.connectionStatus ?? 'not_connected';
  const isConfigured = Boolean(fishSettings?.configured);
  const statusInfo = !isConfigured
    ? { label: 'Not configured', cls: 'border-white/[0.1] text-zinc-300 bg-zinc-900', Icon: AlertCircle }
    : connStatus === 'connected'
    ? { label: 'Connected', cls: 'border-emerald-500/35 text-emerald-300 bg-emerald-500/10', Icon: CheckCircle2 }
    : connStatus === 'error'
    ? { label: 'Authentication failed', cls: 'border-red-500/35 text-red-300 bg-red-500/10', Icon: AlertCircle }
    : { label: 'Saved locally', cls: 'border-amber-500/35 text-amber-300 bg-amber-500/10', Icon: KeyRound };
  const StatusIcon = statusInfo.Icon;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div className="border-b border-white/[0.08] pb-4 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-bold tracking-tight text-white">
            Settings
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
            Configure API integrations, workflow defaults, local storage, saved voices, and style presets.
          </p>
        </div>
      </div>

      {/* Tab Navigation Strip */}
      <div
        role="tablist"
        aria-label="Settings Sections"
        className="flex items-center gap-1 border-b border-white/[0.08] overflow-x-auto no-scrollbar pb-0"
      >
        {TABS.map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(id);
                onTabChange?.(id);
              }}
              className={`min-h-[42px] px-3.5 py-2 text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                active
                  ? 'border-violet-500 text-white bg-white/[0.03]'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.02]'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-violet-400' : 'text-zinc-500'}`} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: API & ENGINES */}
      {activeTab === 'api' && (
        <div className="space-y-5">
          <StudioCard padding="lg" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-violet-400 shrink-0" />
                <h2 className="text-sm font-display font-semibold text-white">
                  Fish Audio API Credentials
                </h2>
              </div>

              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium ${statusInfo.cls}`}>
                <StatusIcon className="w-3.5 h-3.5 shrink-0" />
                <span>{statusInfo.label}</span>
              </div>
            </div>

            {fishSettings && !fishSettings.secureStorageAvailable && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-1"
              >
                <div className="font-semibold text-amber-100">
                  Local Browser Storage Unavailable
                </div>
                <p className="leading-relaxed">{fishSettings.secureStorageDetail}</p>
              </div>
            )}

            {fishSettings?.configured && (
              <div className="p-3 rounded-lg bg-[#18181D] border border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>
                      {fishSettings.source === 'local_storage'
                        ? 'Saved locally on this device (Browser IndexedDB · unencrypted)'
                        : fishSettings.source === 'encrypted_store'
                        ? 'Saved in encrypted backend store'
                        : 'Loaded from server environment (FISH_API_KEY)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="text-xs font-mono text-zinc-100 tracking-wider break-all">
                      {revealedSavedKey !== null ? revealedSavedKey : fishSettings.maskedKey}
                    </div>
                    {fishSettings.source === 'local_storage' && (
                      <button
                        type="button"
                        onClick={() => void handleToggleRevealSavedKey()}
                        aria-label={revealedSavedKey !== null ? 'Hide Saved API Key' : 'Show Saved API Key'}
                        title={revealedSavedKey !== null ? 'Hide API Key' : 'Show API Key'}
                        className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer shrink-0"
                      >
                        {revealedSavedKey !== null ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleToggleEditKey()}
                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{editingKey ? 'Cancel Edit' : 'Edit API Key'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleClearAndReenterKey()}
                    disabled={removingKey}
                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 text-xs font-medium text-amber-200 flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-40"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Clear &amp; Re-enter API Key</span>
                  </button>

                  {(fishSettings.source === 'local_storage' ||
                    fishSettings.source === 'encrypted_store') && (
                    <button
                      type="button"
                      onClick={() => void handleRemoveSavedKey()}
                      disabled={removingKey}
                      className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-xs font-medium text-red-300 flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-40"
                    >
                      {removingKey ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>Remove</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {(editingKey || !fishSettings?.configured) && (
              <form onSubmit={handleSaveApiKey} className="space-y-3">
                <div>
                  <label
                    htmlFor="fish-api-key-input"
                    className="block text-xs font-medium text-zinc-300 mb-1.5"
                  >
                    {fishSettings?.configured ? 'Edit Fish Audio API Key' : 'Fish Audio API Key'}
                  </label>
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                    <div className="relative flex-1 min-w-[200px]">
                      <input
                        ref={apiKeyInputRef}
                        id="fish-api-key-input"
                        type={showKeyInput ? 'text' : 'password'}
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder="Paste your Fish Audio API key..."
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={Boolean(fishSettings && !fishSettings.secureStorageAvailable)}
                        className="w-full min-h-[38px] bg-[#18181D] border border-white/[0.1] rounded-lg pl-3 pr-10 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-violet-500 disabled:opacity-50"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKeyInput((v) => !v)}
                        aria-label={showKeyInput ? 'Hide API Key' : 'Show API Key'}
                        title={showKeyInput ? 'Hide API Key' : 'Show API Key'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white cursor-pointer"
                      >
                        {showKeyInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={
                        savingKey ||
                        testingConn ||
                        !normalizeFishApiKey(apiKeyInput) ||
                        Boolean(fishSettings && !fishSettings.secureStorageAvailable)
                      }
                      className="min-h-[38px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {(savingKey || testingConn) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>{testingConn ? 'Saving & Verifying...' : 'Save & Test Key'}</span>
                    </button>
                  </div>
                </div>
              </form>
            )}

            <div className="p-3 rounded-lg bg-zinc-900/70 border border-white/[0.06] text-[11px] text-zinc-400 space-y-1">
              <div className="flex items-center gap-1.5 font-medium text-zinc-300">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Local Device Storage Notice</span>
              </div>
              <p className="leading-relaxed">
                Your Fish Audio API key is stored locally on this device in browser IndexedDB (unencrypted). Local IndexedDB storage is not equivalent to encrypted server-side secret storage—anyone with access to this browser profile or scripts running on this site could read it. Your key is never stored in any backend database, analytics service, presets, or exports.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
              {fishSettings?.configured && (
                <button
                  type="button"
                  onClick={() => void handleClearAndReenterKey()}
                  disabled={removingKey || testingConn}
                  className="min-h-[36px] px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-white/[0.08] text-xs font-medium text-amber-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Clear &amp; Re-enter API Key</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => void handleTestConnection()}
                disabled={testingConn || (!fishSettings?.configured && !normalizeFishApiKey(apiKeyInput))}
                className="min-h-[36px] px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-white/[0.08] text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {testingConn ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <PlugZap className="w-3.5 h-3.5 text-violet-400" />
                )}
                <span>Test TTS Connection</span>
              </button>
            </div>

            {(fishNotice || (connStatus === 'error' && fishSettings?.lastError)) && (
              <div
                role="status"
                className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                  fishNotice?.kind === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                    : 'bg-red-500/10 border-red-500/30 text-red-200'
                }`}
              >
                {fishNotice?.kind === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                )}
                <span className="flex-1">{fishNotice ? fishNotice.text : fishSettings?.lastError}</span>
              </div>
            )}
          </StudioCard>

          {/* Engine & Service Status */}
          <StudioCard padding="lg" className="space-y-4">
            <h2 className="text-sm font-display font-semibold text-white">
              Engine &amp; Service Status
            </h2>

            {!status ? (
              <div className="text-xs text-zinc-400 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking status...
              </div>
            ) : (
              <div className="divide-y divide-white/[0.06] text-xs">
                <div className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-100">Fish Audio Dubbing</div>
                    <div className="text-zinc-500 mt-0.5">Voice synthesis &amp; speech transcription</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 font-medium">
                    {connStatus === 'connected' ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-300">Connected</span>
                      </>
                    ) : connStatus === 'error' ? (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-red-300">Authentication failed</span>
                      </>
                    ) : isConfigured || status.fishConfigured ? (
                      <>
                        <KeyRound className="w-4 h-4 text-amber-400" />
                        <span className="text-amber-300">Saved locally</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4 text-amber-400" />
                        <span className="text-amber-300">Not configured</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-100">Gemini Translation</div>
                    <div className="text-zinc-500 mt-0.5">External manual workflow always ready</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 font-medium">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">
                      {status.geminiConfigured ? 'API + Manual Ready' : 'Manual Ready'}
                    </span>
                  </div>
                </div>

                <div className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-100">FFmpeg Renderer</div>
                    <div className="text-zinc-500 mt-0.5 font-mono">{status.ffmpegVersion}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 font-medium">
                    {status.ffmpegAvailable ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-300">Ready</span>
                      </>
                    ) : status.clientProcessingAvailable ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-300">Browser WASM Ready</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-red-300">Unavailable</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-zinc-100">Media Stream Analyzer</div>
                    <div className="text-zinc-500 mt-0.5">Reads resolution, duration &amp; audio sync</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 font-medium">
                    {status.ffprobeAvailable ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-300">Ready</span>
                      </>
                    ) : status.clientProcessingAvailable ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-300">Browser Media Ready</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-red-300">Unavailable</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </StudioCard>

          <StudioCard padding="lg" className="space-y-1.5">
            <div className="flex items-center gap-2 text-sm font-display font-semibold text-white">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              Media Rights
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Use Recap Studio AI only with media you own or have permission to edit.
            </p>
          </StudioCard>
        </div>
      )}

      {/* TAB 2: STUDIO DEFAULTS */}
      {activeTab === 'preferences' && (
        <StudioCard padding="lg" className="space-y-4">
          <StudioSectionHeader
            title="Studio Workflow Defaults"
            subtitle="Configure optional style auto-apply and default translation / dubbing settings for new projects."
          />

          {prefs ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="pref-default-style"
                    className="block text-xs font-medium text-zinc-300 mb-1.5"
                  >
                    Default Saved Style
                  </label>
                  <select
                    id="pref-default-style"
                    value={prefs.defaultStyleId || ''}
                    disabled={savingPrefs}
                    onChange={(e) =>
                      void handleUpdatePreferences({
                        defaultStyleId: e.target.value || null,
                      })
                    }
                    className="w-full min-h-[38px] bg-[#18181D] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white"
                  >
                    <option value="">None (No Default Style)</option>
                    {styles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="pref-target-lang"
                    className="block text-xs font-medium text-zinc-300 mb-1.5"
                  >
                    Default Dub Target Language
                  </label>
                  <select
                    id="pref-target-lang"
                    value={prefs.defaultTargetLanguage}
                    disabled={savingPrefs}
                    onChange={(e) =>
                      void handleUpdatePreferences({
                        defaultTargetLanguage: e.target.value as SupportedLanguage,
                      })
                    }
                    className="w-full min-h-[38px] bg-[#18181D] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white"
                  >
                    {SUPPORTED_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="pref-sync-mode"
                    className="block text-xs font-medium text-zinc-300 mb-1.5"
                  >
                    Default Timeline Sync Mode
                  </label>
                  <select
                    id="pref-sync-mode"
                    value={prefs.defaultSyncMode}
                    disabled={savingPrefs}
                    onChange={(e) =>
                      void handleUpdatePreferences({
                        defaultSyncMode: e.target.value as SyncMode,
                      })
                    }
                    className="w-full min-h-[38px] bg-[#18181D] border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white"
                  >
                    <option value="flexible">Flexible (Auto-fit slots)</option>
                    <option value="continuous">Continuous (Sequential narration)</option>
                    <option value="match_original">Match Original Timestamps</option>
                  </select>
                </div>

                <div className="flex items-end">
                  <label className="w-full min-h-[38px] px-3 py-2 rounded-lg bg-[#18181D] border border-white/[0.08] flex items-center justify-between gap-3 text-xs text-zinc-200 cursor-pointer">
                    <span>Auto-apply Default Style on video import</span>
                    <input
                      type="checkbox"
                      checked={prefs.autoApplyDefaultStyleOnImport}
                      disabled={savingPrefs}
                      onChange={(e) =>
                        void handleUpdatePreferences({
                          autoApplyDefaultStyleOnImport: e.target.checked,
                        })
                      }
                      className="accent-violet-500"
                    />
                  </label>
                </div>
              </div>

              {prefsMsg && (
                <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" />
                  <span>{prefsMsg}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-zinc-400 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading preferences...
            </div>
          )}
        </StudioCard>
      )}

      {/* TAB 3: STORAGE & BACKUPS */}
      {activeTab === 'storage' && (
        <div className="space-y-5">
          <StudioCard padding="lg" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-display font-semibold text-white">
                  Storage Usage &amp; Temporary Cleanup
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5 tabular-nums">
                  {storageUsage
                    ? `Total local disk used: ${formatBytes(storageUsage.totalBytes)} · `
                    : ''}
                  Max upload: {status?.maxUploadSizeMb ?? 2048} MB · Retention:{' '}
                  {status?.tempRetentionHours ?? 24}h
                </p>
              </div>
              <button
                type="button"
                onClick={handleCleanup}
                disabled={cleaning}
                className="min-h-[38px] px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                {cleaning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>Clean Temp Files</span>
              </button>
            </div>

            {storageUsage && Object.keys(storageUsage.buckets).length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 text-xs">
                {Object.entries(storageUsage.buckets).map(([bucket, info]) => (
                  <div
                    key={bucket}
                    className="p-2.5 rounded-lg bg-[#16161D] border border-white/[0.07]"
                  >
                    <div className="text-[11px] text-zinc-400 capitalize truncate">{bucket}</div>
                    <div className="font-mono font-semibold text-white tabular-nums mt-0.5">
                      {formatBytes(info.bytes)}
                    </div>
                    <div className="text-[10.5px] text-zinc-500 tabular-nums">
                      {info.files} files
                    </div>
                  </div>
                ))}
              </div>
            )}

            {cleanupMsg && <div className="text-xs text-emerald-400">{cleanupMsg}</div>}
          </StudioCard>

          <StudioCard padding="lg" className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-display font-semibold text-white">
                Portable Backups &amp; Cloud Sync
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Export or restore complete project archives, offline IndexedDB cache, or connect cloud sync.
              </p>
            </div>
            {onOpenBackupModal && (
              <button
                type="button"
                onClick={onOpenBackupModal}
                className="min-h-[38px] px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Archive className="w-3.5 h-3.5" />
                <span>Manage Backups</span>
              </button>
            )}
          </StudioCard>
        </div>
      )}

      {/* TAB 4: SAVED VOICES */}
      {activeTab === 'voices' && (
        <StudioCard padding="lg">
          <MyVoicesManager
            activeProject={activeProject}
            onProjectUpdated={onProjectUpdated}
            onNotice={onNotice}
          />
        </StudioCard>
      )}

      {/* TAB 5: SAVED STYLES */}
      {activeTab === 'styles' && (
        <StudioCard padding="lg">
          <MyStylesManager
            activeProject={activeProject}
            onProjectUpdated={onProjectUpdated}
            onOpenSaveStyleDialog={onOpenSaveStyleDialog}
            onStylesChanged={() => {
              void api.listStyles().then((r) => setStyles(r.styles)).catch(() => {});
              void api.getDefaultPreferences().then((r) => setPrefs(r.preferences)).catch(() => {});
            }}
            onNotice={onNotice}
          />
        </StudioCard>
      )}
    </div>
  );
}
