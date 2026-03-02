import { redirect } from 'next/navigation';

export default function RootPage() {
  // This ensures the journey starts at Level 1: Login
  redirect('/login');
}