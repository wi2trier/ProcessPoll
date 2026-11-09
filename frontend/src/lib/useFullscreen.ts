import { useCallback, useEffect, useRef, useState } from 'react';

export function useFullscreen<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  const native = useRef(false);

  const enter = useCallback(() => {
    setActive(true);
    const el = ref.current;
    try {
      const request = el?.requestFullscreen?.();
      if (request) {
        request.then(
          () => {
            native.current = true;
          },
          () => {
            native.current = false;
          },
        );
      }
    } catch {
      native.current = false;
    }
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    native.current = false;
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } catch {
      return;
    }
  }, []);

  const toggle = useCallback(() => (active ? exit() : enter()), [active, enter, exit]);

  useEffect(() => {
    if (!active) return;
    const onChange = () => {

      if (!document.fullscreenElement && native.current) {
        native.current = false;
        setActive(false);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [active, exit]);

  useEffect(
    () => () => {
      try {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      } catch {
        return;
      }
    },
    [],
  );

  return { ref, active, enter, exit, toggle };
}
