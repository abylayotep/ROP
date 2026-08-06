import { useMemo } from 'react';

const SIZE = 21;

const isFinderArea = (x: number, y: number) => x < 7 && y < 7;

/** Рисунок глаза-искателя: внешняя рамка и центральный квадрат. */
const isFinderInk = (x: number, y: number) => {
  const q = Math.max(Math.abs(x - 3), Math.abs(y - 3));
  return q === 3 || q <= 1;
};

/** Финализатор murmur3: перемешивает биты, чтобы соседние seed давали разный узор. */
function noise(seed: number): boolean {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 7) > 3;
}

/**
 * Код рисуется сеткой div, а не картинкой: в прототипе нет ни одного внешнего
 * изображения. В приложении сюда встанет настоящий payload от WhatsApp — сетка
 * останется, поменяется только источник модулей.
 */
export function QrCode({ seed, size = 180 }: { seed: number; size?: number }) {
  const cells = useMemo(() => {
    const out: string[] = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const finder =
          isFinderArea(x, y) || isFinderArea(SIZE - 1 - x, y) || isFinderArea(x, SIZE - 1 - y);
        let ink: boolean;
        if (finder) {
          const lx = x < 7 ? x : SIZE - 1 - x;
          const ly = y < 7 ? y : SIZE - 1 - y;
          ink = isFinderInk(lx, ly);
        } else {
          // Детерминированный шум: одна и та же сетка при одном seed,
          // «Обновить код» инкрементирует seed и перерисовывает узор.
          //
          // Смешивание обязательно: в прототипе биты seed попадали ровно в те
          // разряды, которые проверяет условие ниже, и при инкременте узор
          // получался тот же самый — кнопка «Обновить код» ничего не меняла.
          ink = noise((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791));
        }
        out.push(ink ? '#0F1413' : '#FFFFFF');
      }
    }
    return out;
  }, [seed]);

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        background: '#FFFFFF',
        border: '1px solid var(--line-3)',
        padding: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateColumns: `repeat(${SIZE},1fr)`,
          gridTemplateRows: `repeat(${SIZE},1fr)`,
          gap: 0,
        }}
      >
        {cells.map((c, i) => (
          <div key={i} style={{ background: c }} />
        ))}
      </div>
    </div>
  );
}
