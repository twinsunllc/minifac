export class StepLoadError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
    readonly location?: { line: number; col?: number },
  ) {
    super(message);
    this.name = "StepLoadError";
  }
}
