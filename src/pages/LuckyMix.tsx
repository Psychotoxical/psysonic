import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildAndPlayLuckyMix } from '../utils/mix/luckyMix';

export default function LuckyMixPage() {
  const navigate = useNavigate();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void buildAndPlayLuckyMix();
    navigate('/now-playing', { replace: true });
  }, [navigate]);

  return null;
}
