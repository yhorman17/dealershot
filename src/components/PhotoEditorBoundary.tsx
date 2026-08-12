import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export class PhotoEditorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[photo-editor] editor initialization failed", error, info.componentStack);
  }

  componentDidUpdate(previous: Readonly<{ children: ReactNode; onClose: () => void }>) {
    if (previous.children !== this.props.children && this.state.error)
      this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <EditorFailure onClose={this.props.onClose} />;
  }
}

export function EditorLoading({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm text-center">
        <div className="mx-auto size-8 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
        <DialogTitle className="mt-2 text-center text-sm font-semibold">
          Opening Customize…
        </DialogTitle>
        <DialogDescription className="text-center text-xs">
          Loading the office photo tools on demand.
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function EditorFailure({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md text-center">
        <AlertTriangle className="mx-auto size-7 text-destructive" />
        <DialogTitle className="text-center text-lg">Customize could not open</DialogTitle>
        <DialogDescription className="text-center">
          The editor failed to initialize. Your photo and page state are safe; close this message
          and try again.
        </DialogDescription>
        <Button className="mt-5" onClick={onClose}>
          Close editor
        </Button>
      </DialogContent>
    </Dialog>
  );
}
