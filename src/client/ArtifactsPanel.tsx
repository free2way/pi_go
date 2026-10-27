import { Download, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RunArtifact } from "../shared/types";
import { api } from "./api";
import { ArtifactDownloadError, diagnosticFilename, type ArtifactDownloadFailure } from "./artifact-download";
import { useT } from "./i18n";

export function ArtifactsPanel({ runId }: { runId: string }) {
  const { t } = useT();
  const [items, setItems] = useState<RunArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ArtifactDownloadFailure | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.artifacts(runId).then(({ artifacts }) => {
      if (active) setItems(artifacts.filter((item) => item.kind !== "patch"));
    }).catch(() => { if (active) setLoadFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [runId, revision]);
  useEffect(() => () => {
    controller.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);
  const refresh = () => {
    setLoading(true); setLoadFailed(false); setFailure(null); setDownloaded(false);
    setRevision((value) => value + 1);
  };
  const download = async (artifact: RunArtifact) => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setPending(artifact.artifactId); setFailure(null); setDownloaded(false);
    try {
      const blob = await api.downloadDiagnosticArtifact(artifact, request.signal);
      if (request.signal.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      const link = document.createElement("a");
      link.href = url; link.download = diagnosticFilename(artifact);
      document.body.appendChild(link); link.click(); link.remove();
      setDownloaded(true);
    } catch (error) {
      if (!request.signal.aborted) setFailure(error instanceof ArtifactDownloadError ? error.reason : "failed");
    } finally {
      if (!request.signal.aborted) { controller.current = null; setPending(null); }
    }
  };
  return <section className="diagnostic-artifacts" aria-label={t("artifacts.title")}>
    <div className="artifact-bar">
      <p className="artifact-hint">{t("artifacts.hint")}</p>
      <button type="button" className="button secondary" disabled={loading || pending !== null} onClick={refresh}>
        <RotateCcw size={14} />{t("artifacts.refresh")}
      </button>
    </div>
    {loading ? <p role="status"><LoaderCircle className="spin" size={14} /> {t("artifacts.loading")}</p>
      : loadFailed ? <p role="alert" className="form-error">{t("artifacts.loadFailed")}</p>
        : items.length === 0 ? <p className="artifact-hint">{t("artifacts.empty")}</p>
          : <ul className="diagnostic-artifact-list">{items.map((artifact) => <li key={artifact.artifactId}>
            <div><strong>{artifact.artifactId}</strong><span>{artifact.kind} · {artifact.bytes.toLocaleString()} bytes</span>
              <code title={artifact.sha256 ?? undefined}>SHA-256 {artifact.sha256?.slice(0, 16) ?? "—"}</code></div>
            <button type="button" className="button secondary" disabled={pending !== null} aria-label={t("artifacts.downloadNamed", { name: artifact.artifactId })} onClick={() => void download(artifact)}>
              {pending === artifact.artifactId ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{t("artifacts.download")}
            </button>
          </li>)}</ul>}
    {failure ? <p role="alert" className="form-error">{t(`artifacts.error.${failure}`)}</p> : null}
    {downloaded ? <p role="status" className="artifact-hint">{t("artifacts.downloaded")}</p> : null}
  </section>;
}
