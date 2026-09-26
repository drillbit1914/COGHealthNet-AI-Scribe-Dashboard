'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePatientSearch } from '@/components/admin/patient-search';
import { Empty, inp, PageHeader, Pill, td, th } from '@/components/admin/ui';

export default function PatientsPage() {
  const [term, setTerm] = useState('');
  const hits = usePatientSearch(term);
  return (
    <div>
      <PageHeader title="Patients">
        <input
          className={`${inp} w-80`}
          placeholder="Search child, parent or phone"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search patients"
        />
      </PageHeader>
      <table className="w-full rounded-lg bg-white">
        <thead>
          <tr>
            <th className={th}>Child</th>
            <th className={th}>Date of birth</th>
            <th className={th}>Guardians</th>
            <th className={th}>No-shows</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((p) => (
            <tr key={p.id}>
              <td className={td}>
                <Link href={`/admin/patients/${p.id}`} className="text-jacaranda font-bold hover:underline">
                  {p.full_name}
                </Link>{' '}
                {p.needs_admin_match && <Pill value="MATCH" label="needs match" />}
              </td>
              <td className={td}>{p.dob?.slice(0, 10) ?? '—'}</td>
              <td className={td}>{p.guardians}</td>
              <td className={td}>{p.no_shows}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!hits.length && <Empty>No patients found.</Empty>}
    </div>
  );
}
