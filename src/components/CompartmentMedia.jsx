import { useCallback } from 'react';
import ImageCarousel from './ImageCarousel.jsx';
import { deleteAsset, setMainImage, useGallery } from '../lib/gallery.js';

/**
 * Loads the server gallery for a compartment and renders the carousel. Reloads when the planner revision changes so
 * the "image may be outdated" badge follows assignment changes.
 * @param {{comp:{id:string, images:{src:string,title:string}[]}, session:{canEdit:boolean,status:string}, signIn:()=>void,
 *   plannerRevision:number, mainImage:object|undefined, studioAvailable:boolean, onOpenStudio:(step?:string)=>void}} props
 */
export default function CompartmentMedia({ comp, session, signIn, plannerRevision, mainImage, studioAvailable, onOpenStudio }) {
  const gallery = useGallery(comp.id, { editor: session.canEdit, version: plannerRevision });
  const main = gallery.main ?? mainImage ?? null;
  const { refresh } = gallery;

  const onSetMain = useCallback(async item => {
    await setMainImage(comp.id, { kind: item.kind, ref: item.ref, expectRevision: main?.revision ?? 0 });
    refresh();
  }, [comp.id, main?.revision, refresh]);
  const onDelete = useCallback(async item => { await deleteAsset(comp.id, item.id); refresh(); }, [comp.id, refresh]);

  return (
    <ImageCarousel
      key={comp.id}
      compId={comp.id}
      presetImages={comp.images}
      main={main}
      items={gallery.items}
      canEdit={session.canEdit}
      studioAvailable={studioAvailable}
      signedOut={session.status === 'signed_out'}
      onOpenStudio={onOpenStudio}
      onSignIn={signIn}
      onSetMain={onSetMain}
      onDelete={onDelete}
    />
  );
}
