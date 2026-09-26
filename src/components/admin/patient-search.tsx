'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { inp } from './ui';

export interface PatientHit {
  id: string;
  full_name: string;
  dob: string | null;
  needs_admin_match: boolean;
  no_shows: number;
  guardians: string | null;
}

/** Debounced search by child name, guardian name or phone. */
export function usePatientSearch(term: string) {
  const [hits, setHits] = useState<PatientHit[]>([]);
  useEffect(() => {
    const h = setTimeout(() => {
      api<PatientHit[]>(`/api/admin/patients?q=${encodeURIComponent(term)}`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(h);
  }, [term]);
  return hits;
}

export function PatientPicker({
  value,
  onChange,
  exclude,
}: {
  value: PatientHit | null;
  onChange: (p: PatientHit | null) => void;
  exclude?: string;
}) {
  const [term, setTerm] = useState('');
  const hits = usePatientSearch(term).filter((h) => h.id !== exclude);
  if (value)
    return (
      <div className="flex items-center gap-2 text-sm">
        <b>{value.full_name}</b>
        <button type="button" className="text-jacaranda underline" onClick={() => onChange(null)}>
          change
        </button>
      </div>
    );
  return (
    <div className="flex flex-col gap-1">
      <input
        className={inp}
        placeholder="Search child, parent or phone"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        aria-label="Search patients"
      />
      {term && (
        <ul className="border-line max-h-48 overflow-auto rounded-md border bg-white text-sm">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="hover:bg-jacaranda-light w-full px-2 py-1 text-left"
                onClick={() => onChange(h)}
              >
                <b>{h.full_name}</b> <span className="text-muted">{h.guardians}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
