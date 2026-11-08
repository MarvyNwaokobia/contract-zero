import { useEffect, useRef } from 'react';
import { getInputSystem, InputSystem } from './InputSystem';

export function useInput(): InputSystem {
  const input = useRef(getInputSystem()).current;

  useEffect(() => {
    const cleanup = input.attach(window);
    return cleanup;
  }, [input]);

  return input;
}
