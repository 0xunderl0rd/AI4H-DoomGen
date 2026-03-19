export interface Planner {
  planPrompt(prompt: string): Promise<unknown>;
}
