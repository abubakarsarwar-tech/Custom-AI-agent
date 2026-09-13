export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface Todo {
  content: string;
  status: TodoStatus;
  priority?: 'low' | 'medium' | 'high';
  note?: string;
}

/**
 * The plan the agent keeps for itself. Long tasks fall apart without one:
 * a 7B model with an 8k context forgets what it was doing five tool calls ago.
 * Re-injecting this list keeps it on the rails.
 */
export class PlanStore {
  private items: Todo[] = [];

  set(items: Todo[]): void {
    this.items = items.map((t) => ({ ...t }));
  }

  all(): Todo[] {
    return this.items.map((t) => ({ ...t }));
  }

  clear(): void {
    this.items = [];
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get done(): number {
    return this.items.filter((t) => t.status === 'completed').length;
  }

  render(): string {
    if (this.items.length === 0) return '(no plan yet)';
    const mark: Record<TodoStatus, string> = {
      pending: '[ ]',
      in_progress: '[~]',
      completed: '[x]',
      blocked: '[!]',
    };
    return this.items
      .map((t, i) => `${i + 1}. ${mark[t.status] ?? '[ ]'} ${t.content}${t.note ? ` — ${t.note}` : ''}`)
      .join('\n');
  }
}
