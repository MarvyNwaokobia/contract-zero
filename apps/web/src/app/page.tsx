import { redirect } from 'next/navigation'

// Placeholder until the Main Menu exists: training is the only playable route.
export default function Home() {
  redirect('/training')
}
