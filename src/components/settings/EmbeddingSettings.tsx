import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import DetailedHint from "../ui/DetailedHint";
import Input from "../ui/Input";
import Toggle from "../ui/Toggle";
import { useSettings } from "../../hooks/useSettings";

interface VectorAvailability {
  available: boolean;
  reason: string | null;
  dimensions?: number | null;
  model?: string | null;
}

interface EmbeddingProbeResult {
  ok: boolean;
  dimensions: number;
  latencyMs: number;
  error?: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The retrieval model, kept separate from the chat models it has nothing to do
 * with. The endpoint and model name are persisted by the Rust side when a probe
 * succeeds, so there is nothing to save from here.
 */
export default function EmbeddingSettings() {
  const { t } = useTranslation();
  const { settings, save: saveSetting } = useSettings();
  const [availability, setAvailability] = useState<VectorAvailability>({
    available: false,
    reason: "requires_compatible_provider",
  });
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<EmbeddingProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAvailability = useCallback(async () => {
    const next = await invoke<VectorAvailability>("ai_vector_retrieval_status");
    setAvailability(next);
  }, []);

  useEffect(() => {
    void refreshAvailability().catch(() => {
      setAvailability({ available: false, reason: "requires_compatible_provider" });
    });
  }, [refreshAvailability]);

  useEffect(() => {
    setEndpoint(settings.ai_embedding_endpoint || "http://localhost:11434/v1/embeddings");
    setModel(settings.ai_embedding_model || "text-embedding-3-small");
  }, [settings.ai_embedding_endpoint, settings.ai_embedding_model]);

  const toggleVectorRetrieval = async (enabled: boolean) => {
    setError(null);
    try {
      await invoke("set_ai_vector_retrieval", { enabled });
      await saveSetting("ai_vector_retrieval", enabled ? "true" : "false");
      await refreshAvailability();
    } catch (nextError) {
      setError(errorText(nextError));
      await refreshAvailability().catch(() => {});
    }
  };

  const testEmbedding = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await invoke<EmbeddingProbeResult>("ai_embedding_probe", {
        endpoint,
        model,
        apiKey: apiKey || null,
      });
      setProbe(result);
      if (result.ok) {
        // Never keep the key in component state once it has been accepted.
        setApiKey("");
        await refreshAvailability();
      }
    } catch (nextError) {
      setProbe(null);
      setError(errorText(nextError));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[620px] pb-6 pt-2">
      <div className="mb-4 border-b border-border pb-4">
        <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.embeddingTitle")}</h4>
        <DetailedHint
          className="mt-0.5"
          hint={t("settings.ai.embeddingHint")}
          detail={t("settings.ai.embeddingDetail")}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="http://localhost:11434/v1/embeddings"
          />
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="text-embedding-3-small"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t("settings.ai.embeddingKeyPlaceholder")}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void testEmbedding()}
            disabled={testing || !endpoint.trim() || !model.trim()}
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
            {t("settings.ai.embeddingTest")}
          </Button>
        </div>
        {(probe || availability.available) && (
          <p className={`mt-2 text-[11px] ${probe?.ok === false ? "text-danger-text" : "text-success-text"}`}>
            {probe?.ok === false
              ? t("settings.ai.embeddingFailed")
              : t("settings.ai.embeddingAvailable", {
                  dimensions: probe?.dimensions ?? availability.dimensions,
                  latency: probe?.latencyMs ?? "-",
                })}
          </p>
        )}
      </div>

      <div className="flex min-h-[73px] items-center justify-between gap-4 border-b border-border py-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.vectorRetrieval")}</h4>
          <DetailedHint
            className="mt-0.5"
            hint={
              availability.available
                ? t("settings.ai.vectorRetrievalHint")
                : t("settings.ai.vectorRetrievalUnavailable")
            }
            detail={t("settings.ai.vectorRetrievalDetail")}
          />
        </div>
        <Toggle
          checked={settings.ai_vector_retrieval === "true"}
          onChange={(enabled) => void toggleVectorRetrieval(enabled)}
          disabled={!availability.available}
          label={t("settings.ai.vectorRetrieval")}
        />
      </div>

      {error && <p className="mt-3 text-[11px] text-danger-text">{error}</p>}
    </div>
  );
}
