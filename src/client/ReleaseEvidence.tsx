import { Check, Copy, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import type { MessageKey } from "../shared/i18n";
import { useT } from "./i18n";

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface ReleaseEvidenceValue {
  commit?: string;
  deploymentId?: string;
  image?: string;
  imageDigest?: string;
  expectedImageDigest?: string;
}

export interface ReleaseEvidenceRow {
  key: keyof ReleaseEvidenceValue;
  label: MessageKey;
  value: string;
}

/**
 * Builds the canonical evidence projection used by both release surfaces.
 * Keeping this pure prevents either UI from silently omitting a digest field.
 */
export function releaseEvidenceRows(value: ReleaseEvidenceValue): ReleaseEvidenceRow[] {
  const candidates: Array<[keyof ReleaseEvidenceValue, MessageKey]> = [
    ["commit", "release.evidence.commit"],
    ["deploymentId", "release.evidence.deploymentId"],
    ["image", "release.evidence.image"],
    ["imageDigest", "release.evidence.actualDigest"],
    ["expectedImageDigest", "release.evidence.stagingDigest"],
  ];
  return candidates.flatMap(([key, label]) => {
    const text = value[key]?.trim();
    return text ? [{ key, label, value: text }] : [];
  });
}

export function releaseEvidenceStatus(value: ReleaseEvidenceValue): "verified" | "mismatch" | "incomplete" {
  if (!IMAGE_DIGEST.test(value.imageDigest ?? "")) return "incomplete";
  if (value.expectedImageDigest && value.expectedImageDigest !== value.imageDigest) return "mismatch";
  return "verified";
}

export function ReleaseEvidence({ value }: { value: ReleaseEvidenceValue }) {
  const { t } = useT();
  const [copied, setCopied] = useState<keyof ReleaseEvidenceValue>();
  const rows = releaseEvidenceRows(value);
  if (rows.length === 0) return null;
  const status = releaseEvidenceStatus(value);

  const copy = async (row: ReleaseEvidenceRow) => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(row.value);
    setCopied(row.key);
    window.setTimeout(() => setCopied((current) => current === row.key ? undefined : current), 1_500);
  };

  return (
    <section className="release-evidence" aria-label={t("release.evidence.title")}>
      <div className="release-evidence-head">
        <div><ShieldCheck size={13} /><strong>{t("release.evidence.title")}</strong></div>
        <span className={`is-${status}`}>
          {status === "mismatch" ? <ShieldX size={11} /> : <ShieldCheck size={11} />}
          {t(`release.evidence.${status}`)}
        </span>
      </div>
      <dl>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{t(row.label)}</dt>
            <dd title={row.value}>{row.value}</dd>
            <button type="button" onClick={() => void copy(row)} aria-label={t("release.evidence.copy", { label: t(row.label) })}>
              {copied === row.key ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        ))}
      </dl>
    </section>
  );
}
