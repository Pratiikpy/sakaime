import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { EmptyState } from "./components/feedback";
import { PageHeader, useDocTitle } from "./components/ui";
import { About } from "./screens/About";
import { CaseOverview } from "./screens/CaseOverview";
import { ClaimXray, ClaimXrayIndex } from "./screens/ClaimXray";
import { Dossier } from "./screens/Dossier";
import { Drills } from "./screens/Drills";
import { Guard } from "./screens/Guard";
import { Investigation } from "./screens/Investigation";
import { Lab } from "./screens/Lab";
import { Landing } from "./screens/Landing";
import { Matrix } from "./screens/Matrix";
import { ReviewDesk } from "./screens/ReviewDesk";
import { Sources } from "./screens/Sources";
import { Timeline } from "./screens/Timeline";

function NotFound() {
  useDocTitle("Page not found");
  return (
    <>
      <PageHeader eyebrow="404" title="That page does not exist" />
      <EmptyState title="Nothing at this address" icon="empty" action={<Link className="btn btn-primary" to="/">Go to the start</Link>}>
        The link may be mistyped or from an older version.
      </EmptyState>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          <Route path="sources" element={<Sources />} />
          <Route path="cases" element={<ReviewDesk />} />
          <Route path="cases/:id" element={<CaseOverview />} />
          <Route path="cases/:id/matrix" element={<Matrix />} />
          <Route path="cases/:id/claims" element={<ClaimXrayIndex />} />
          <Route path="cases/:id/claims/:findingId" element={<ClaimXray />} />
          <Route path="cases/:id/lab" element={<Lab />} />
          <Route path="cases/:id/timeline" element={<Timeline />} />
          <Route path="cases/:id/drills" element={<Drills />} />
          <Route path="cases/:id/investigation" element={<Investigation />} />
          <Route path="cases/:id/dossier" element={<Dossier />} />
          <Route path="guard" element={<Guard />} />
          <Route path="about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
