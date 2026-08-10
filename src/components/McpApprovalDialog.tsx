import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CircleDollarSign, Loader2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { focusFirstElement, trapTabKey } from "./focus-trap";
import Button from "./ui/Button";

type CostDisclosure =
  | { kind: "estimated"; amount: string }
  | { kind: "upper_bound"; amount: string }
  | { kind: "provider_may_charge" };

type ApprovalConfirmation =
  | { risk: "irreversible_data"; effect: string; scope: string }
  | {
    risk: "paid_api";
    effect: string;
    scope: string;
    service: string;
    model: string;
    maximum_requests: number;
    cost: CostDisclosure;
  };

interface ApprovalRequest {
  id: string;
  confirmation: ApprovalConfirmation;
}

function costDescription(cost: CostDisclosure, t: (key: string, values?: Record<string, string | number>) => string) {
  switch (cost.kind) {
    case "estimated":
      return t("mcpApproval.cost.estimated", { amount: cost.amount });
    case "upper_bound":
      return t("mcpApproval.cost.upperBound", { amount: cost.amount });
    case "provider_may_charge":
      return t("mcpApproval.cost.providerMayCharge");
  }
}

/**
 * Resolves high-risk requests from MCP clients that do not offer native MCP
 * elicitation. Native confirmations are stored on a separate channel and
 * never reach this component.
 */
export default function McpApprovalDialog() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const refresh = useCallback(async () => {
    try {
      const pending = await invoke<ApprovalRequest[]>("mcp_list_pending_approvals");
      setRequests(pending);
      setError(false);
    } catch {
      // Do not expose backend error text in a confirmation dialog. It can
      // contain implementation details and gives the user no useful remedy.
      setError(true);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const start = async () => {
      try {
        unlisten = await listen("mcp:approvals-changed", () => {
          void refresh();
        });
      } catch {
        if (!disposed) setError(true);
        return;
      }
      if (disposed) {
        unlisten();
        return;
      }
      void refresh();
    };

    void start();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const request = requests[0];
  const resolve = useCallback(async (decision: "approve" | "reject") => {
    if (!request) return;
    setBusy(decision);
    setError(false);
    try {
      await invoke(
        decision === "approve" ? "mcp_approve_action" : "mcp_reject_action",
        { id: request.id },
      );
      await refresh();
    } catch {
      setError(true);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh, request]);

  useEffect(() => {
    if (!request) return;
    const dialog = dialogRef.current;
    focusFirstElement(dialog);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopPropagation();
        void resolve("reject");
        return;
      }
      if (event.key !== "Tab") return;
      trapTabKey(event, dialog);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, request, resolve]);

  if (!request) return null;

  const isPaid = request.confirmation.risk === "paid_api";
  const confirmation = request.confirmation;
  const Icon = isPaid ? CircleDollarSign : TriangleAlert;

  return createPortal(
    <div className="motion-scrim fixed inset-0 z-[110] flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="motion-dialog w-[min(480px,calc(100vw-32px))] rounded-lg border border-border bg-bg-surface p-5 shadow-context"
      >
        <div className="flex items-start gap-3">
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-md ${isPaid ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-danger-bg text-danger-text"}`}>
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold text-text-primary">
              {t(isPaid ? "mcpApproval.paidTitle" : "mcpApproval.irreversibleTitle")}
            </h2>
            <p id={descriptionId} className="mt-1 break-words text-[13px] leading-5 text-text-secondary">
              {confirmation.effect}
            </p>
          </div>
        </div>

        <dl className="mt-4 grid gap-2 rounded-md border border-border bg-bg-muted/40 p-3 text-[12px] leading-5">
          <div>
            <dt className="font-medium text-text-muted">{t("mcpApproval.scope")}</dt>
            <dd className="break-words text-text-primary">{confirmation.scope}</dd>
          </div>
          {confirmation.risk === "paid_api" && (
            <>
              <div>
                <dt className="font-medium text-text-muted">{t("mcpApproval.service")}</dt>
                <dd className="break-words text-text-primary">{confirmation.service}</dd>
              </div>
              <div>
                <dt className="font-medium text-text-muted">{t("mcpApproval.model")}</dt>
                <dd className="break-words text-text-primary">{confirmation.model}</dd>
              </div>
              <div>
                <dt className="font-medium text-text-muted">{t("mcpApproval.maximumRequests")}</dt>
                <dd className="text-text-primary">{confirmation.maximum_requests}</dd>
              </div>
              <div>
                <dt className="font-medium text-text-muted">{t("mcpApproval.cost.label")}</dt>
                <dd className="text-text-primary">{costDescription(confirmation.cost, t)}</dd>
              </div>
            </>
          )}
        </dl>

        {requests.length > 1 && (
          <p className="mt-3 text-[12px] text-text-muted">
            {t("mcpApproval.remaining", { count: requests.length - 1 })}
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-[12px] text-danger-text">{t("mcpApproval.error")}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="md" disabled={busy !== null} onClick={() => void resolve("reject")}>
            {busy === "reject" && <Loader2 size={14} className="animate-spin" />}
            {t("mcpApproval.reject")}
          </Button>
          <Button size="md" disabled={busy !== null} onClick={() => void resolve("approve")}>
            {busy === "approve" && <Loader2 size={14} className="animate-spin" />}
            {t("mcpApproval.approve")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
