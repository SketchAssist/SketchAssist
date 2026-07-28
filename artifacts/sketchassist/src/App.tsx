import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Editor from "@/pages/editor";
import Export from "@/pages/export";
import { SetupWizard } from "@/components/setup-wizard";
import { useSetup } from "@/hooks/use-setup";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/project/:id" component={Editor} />
      <Route path="/project/:id/export" component={Export} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppInner() {
  const { setupComplete, markComplete } = useSetup();
  return (
    <>
      {!setupComplete && <SetupWizard onComplete={markComplete} />}
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
      <Toaster />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppInner />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
