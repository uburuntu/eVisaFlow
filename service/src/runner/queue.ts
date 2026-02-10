type QueueItem = {
  telegramId: number;
  memberName: string;
  execute: () => Promise<void>;
  onPositionUpdate: (position: number) => void;
};

const queue: QueueItem[] = [];
let activeCount = 0;
let concurrency = 2;

export function setConcurrency(n: number): void {
  concurrency = n;
}

/** Returns the current number of items waiting (not including active). */
export function getPosition(): number {
  return queue.length;
}

export async function enqueue(
  telegramId: number,
  memberName: string,
  execute: () => Promise<void>,
  onPositionUpdate: (position: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const item: QueueItem = {
      telegramId,
      memberName,
      execute: async () => {
        try {
          await execute();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      onPositionUpdate,
    };
    queue.push(item);
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  while (activeCount < concurrency && queue.length > 0) {
    const item = queue.shift()!;
    activeCount++;

    // Notify remaining items of their new positions
    for (let i = 0; i < queue.length; i++) {
      queue[i].onPositionUpdate(i);
    }

    // Notify the starting item
    item.onPositionUpdate(0);

    item.execute().finally(() => {
      activeCount--;
      processQueue();
    });
  }
}

export function getQueueStats(): { active: number; waiting: number } {
  return { active: activeCount, waiting: queue.length };
}
