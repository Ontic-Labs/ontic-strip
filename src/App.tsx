import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AdminFeeds from "./pages/AdminFeeds";
import ClaimSearch from "./pages/ClaimSearch";
import Docs from "./pages/Docs";
import DocumentDetail from "./pages/DocumentDetail";
import FeedView from "./pages/Index";
import InoreaderCallback from "./pages/InoreaderCallback";
import Landing from "./pages/Landing";
import Leaderboard from "./pages/Leaderboard";
import Privacy from "./pages/Privacy";
import PublisherDetail from "./pages/PublisherDetail";
import PublisherList from "./pages/PublisherList";
import Stories from "./pages/Stories";
import StoryDetail from "./pages/StoryDetail";
import Terms from "./pages/Terms";

import ComparePublishers from "./pages/ComparePublishers";
import JobHealth from "./pages/JobHealth";
import NotFound from "./pages/NotFound";
import TrendingClaims from "./pages/TrendingClaims";

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/feed" element={<FeedView />} />
            <Route path="/stories" element={<Stories />} />
            <Route path="/stories/:id" element={<StoryDetail />} />
            <Route path="/document/:id" element={<DocumentDetail />} />
            <Route path="/publishers" element={<PublisherList />} />
            <Route path="/publisher/:name" element={<PublisherDetail />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/compare" element={<ComparePublishers />} />
            <Route path="/search" element={<ClaimSearch />} />

            <Route path="/claims" element={<TrendingClaims />} />
            <Route path="/admin/feeds" element={<AdminFeeds />} />
            <Route path="/health" element={<JobHealth />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/methodology" element={<Navigate to="/docs" replace />} />
            <Route path="/inoreader/callback" element={<InoreaderCallback />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
