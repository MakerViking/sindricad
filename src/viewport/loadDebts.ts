// What a document that has just replaced the last one is still owed by the
// view: a Fit, a camera that forgets the user's moves over the document before
// it, and for one that was loaded, a word about bodies it opened hidden
// (hiddenBodiesCue). And, the part that keeps going wrong, WHICH build owes
// them.
//
// From ee204bc (2026-08-08) to 2026-09-26 the fit was armed once, at launch,
// and the blank startup document's empty reply spent it, so no document opened
// afterwards was ever framed. Two looser fixes were traced in review, each
// paying the debt to the wrong build:
//   - "the next build" can be the OLD document's. A replacement cancels the
//     rebuild in flight, but once the worker has returned, that reply still
//     completes and is published after the load. Armed at the replacement, it
//     spent the fit and the cue, and the opened document came up unframed.
//   - "the next build with triangles" can be any build at all. After a load
//     that built no solid (sketches only, or a failed rebuild) the fit waited,
//     and the first Extrude or Loft preview yanked the camera mid-tool.
// So the debts are armed when the owing build STARTS, and whatever it has not
// paid when it settles is forgiven. Every build state the store emits between
// a start and the next settle is that build's: the store serialises rebuilds,
// and `building` turns true only in emitBuildStarted.
//
// One exception to "forgiven". When the connection to the engine drops, every
// call in flight settles as failed, and the reconnect rebuilds the very same
// document with nothing in between. Forgiven there, a document whose connection
// dropped mid-load came back unframed and without its cue (measured in the
// app, closing the socket while the opened document built). So a debt that
// settled with NOTHING built is kept aside, and a reconnect re-arms it, unless
// some other build started first.
//
// The camera release is owed to the owing build's FIRST FRAME, not to the
// replacement. The replaced document stays on screen, and navigable, until the
// new one draws (its reply's stream begin, or its commit when it does not
// stream), and a cold 340-body open spends 60 to 150 s in OCCT before that.
// Released at the replacement, one wheel notch in that minute counted as the
// user steering the NEW document, and it came up unframed. Only moves made
// while the new document is on screen may cost it its fit.

export type Replacement = "new" | "load";

export interface Debts {
  fit: boolean;
  cue: boolean;
  /** Forget the user's camera moves (viewport.releaseCamera) before drawing. */
  release: boolean;
}

const NONE: Readonly<Debts> = { fit: false, cue: false, release: false };

export class LoadDebts implements Debts {
  /** The running build owes the camera a Fit. Whoever frames the model early
   *  (a stream's first frame) clears it, so the commit does not fit again. */
  fit = false;
  /** The running build owes the user the hidden-bodies cue. */
  cue = false;
  /** The running build has not drawn yet, and its first frame is to release
   *  the camera. Paid by firstFrame() at a stream's begin, else at the settle. */
  release = false;
  /** What the next build to start will owe. Launch owes its first build a Fit:
   *  the blank startup document's, which frames a 50 mm view of the origin.
   *  No release: nothing came before it, and the camera flags start clear. */
  private next: Debts | null = { fit: true, cue: false, release: false };
  /** What the last build settled owing with no model to pay it on. */
  private unpaid: Debts | null = null;

  /** The document was replaced (store.onReplace). Both kinds owe a Fit and a
   *  camera release at their first frame; only a document LOADED owes the cue.
   *  File > New does call resetView() itself, but at that moment the viewport
   *  still holds the OLD model (the replacement publishes no result, and
   *  main.ts renders only a result), so that Fit framed the document just
   *  closed: File > New after a 3 m box stayed 7.8 m out over an empty
   *  document. The blank build's own Fit frames the origin. Nothing is owed
   *  any more to a reply still in flight for the old one. */
  replaced(how: Replacement) {
    this.next = { fit: true, cue: how === "load", release: true };
    this.fit = false;
    this.cue = false;
    this.release = false;
    this.unpaid = null;
  }

  /** The engine connection came back, and main.ts is about to rebuild. If the
   *  last build settled with nothing built and no build has started since, it
   *  is the same document the user was owed for: owe it again. */
  reconnected() {
    if (this.unpaid) this.next = this.unpaid;
    this.unpaid = null;
  }

  /** Feed every build state, in order (store.onBuild). Returns what THIS
   *  state has to pay: nothing while a build runs, and at its settle whatever
   *  it still owes, exactly once. */
  onBuild(s: { building: boolean; result?: unknown }): Debts {
    if (s.building) {
      if (this.next) {
        this.fit = this.next.fit;
        this.cue = this.next.cue;
        this.release = this.next.release;
        this.next = null;
      }
      this.unpaid = null; // a build started, so a reconnect is no longer a retry
      return NONE;
    }
    const due = { fit: this.fit, cue: this.cue, release: this.release };
    this.fit = false;
    this.cue = false;
    this.release = false;
    // Nothing was built to pay these on (main.ts renders only a result): the
    // replacement cleared the old model, so a failed load settles with none.
    if (!s.result && (due.fit || due.cue)) this.unpaid = due;
    return due;
  }

  /** The running build is drawing its first frame early: a stream's begin
   *  (store.onBuildChunk). Returns whether to release the camera before it,
   *  once; the settle then owes no release. */
  firstFrame(): boolean {
    const release = this.release;
    this.release = false;
    return release;
  }
}
