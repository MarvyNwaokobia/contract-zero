import { redirect } from 'next/navigation'

// Placeholder until the Main Menu exists: the FPS sandbox is the only playable route.
export default function Home() {
  redirect('/dev/verb')
}
