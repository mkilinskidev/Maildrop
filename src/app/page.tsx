import { redirect } from "next/navigation";

import { getCurrentSession } from "@/modules/auth/application/session";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import { LogoutButton } from "@/components/logout-button";
import { AccountList } from "@/components/account-list";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import Link from "next/link";
import { db } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const accounts = await accountsService.list();

  return (
    <main className="page-shell">
      <section className="wide">
        <header className="page-header">
          <div>
            <h1>Maildock</h1>
            <p>Mail accounts</p>
          </div>
          <div className="actions">
            <Link className="button-link" href="/accounts/new">
              Add account
            </Link>
            <LogoutButton />
          </div>
        </header>
        <AccountList accounts={accounts} />
      </section>
    </main>
  );
}
