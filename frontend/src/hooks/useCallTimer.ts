'use client';
import { useState, useEffect, useRef, useCallback } from 'react';

export function useCallTimer() {
    const [seconds, setSeconds] = useState(0);
    const [isRunning, setIsRunning] = useState(false);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const secondsRef = useRef(0);

    useEffect(() => {
        secondsRef.current = seconds;
    }, [seconds]);

    useEffect(() => {
        if (isRunning) {
            intervalRef.current = setInterval(() => {
                setSeconds((s) => s + 1);
            }, 1000);
        } else if (intervalRef.current) {
            clearInterval(intervalRef.current);
        }
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [isRunning]);

    const start = useCallback(() => {
        setSeconds(0);
        setIsRunning(true);
    }, []);

    const stop = useCallback(() => {
        setIsRunning(false);
        return secondsRef.current;
    }, []);

    const reset = useCallback(() => {
        setSeconds(0);
        setIsRunning(false);
    }, []);

    const formatted = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

    return { seconds, formatted, isRunning, start, stop, reset };
}
