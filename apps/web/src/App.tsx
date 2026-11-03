import { BillPage } from './BillPage';

export function App() {
  const m = window.location.pathname.match(/^\/(?:s|bill)\/([\w-]+)\/?$/);
  if (m?.[1]) return <BillPage token={m[1]} />;
  return (
    <main className="page center">
      <img src="/icon-512.png" alt="" width={72} height={72} className="logo" />
      <h1>TABLY</h1>
      <p className="sub">Open the link a friend sent you to pick what you ordered.</p>
    </main>
  );
}
