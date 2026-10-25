import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useConfirm } from './Confirm';
import { ProductPicture, useToast } from './ui';

/**
 * A record's one picture (2026-10-25): an item's on its stock card, a G-HR
 * asset's on its page. Shown to every reader, set or removed by whoever may
 * change the record through `POST` / `DELETE <path>`; the server fits it
 * inside 800 px and keeps a JPEG. With no photo and no right, nothing is drawn.
 */
export function PhotoCard({
  path,
  label,
  shownOn,
  name,
  photoId,
  toneKey,
  canEdit,
  onChanged,
  onError,
}: {
  /** The record's photo route under /api, e.g. `/items/:id/photo`. */
  path: string;
  label: string;
  /** Where the initials show instead, said when removing: "The cards and the stock card show". */
  shownOn: string;
  name: string;
  photoId: string | null;
  toneKey: string | null;
  canEdit: boolean;
  onChanged: (photoId: string | null) => void;
  onError: (err: unknown) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const saved = await api.post<{ photoId: string }>(path, form);
      onChanged(saved.photoId);
      toast('ok', 'Photo saved');
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  function remove() {
    confirm.ask({
      title: `Remove the photo of ${name}?`,
      body: `${shownOn} its initials until another photo is added.`,
      confirmLabel: 'Remove photo',
      onConfirm: async () => {
        await api.del(path);
        onChanged(null);
        toast('ok', 'Photo removed');
      },
    });
  }
  if (!photoId && !canEdit) return null;
  return (
    <section className="card item-photo-card" aria-label={label}>
      {confirm.bar}
      <ProductPicture photoId={photoId} name={name} toneKey={toneKey} className="item-photo" />
      {canEdit && (
        <div className="row item-photo-actions">
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {photoId ? 'Change photo' : 'Add photo'}
          </button>
          {photoId && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy || confirm.open} onClick={remove}>
              Remove
            </button>
          )}
        </div>
      )}
    </section>
  );
}
