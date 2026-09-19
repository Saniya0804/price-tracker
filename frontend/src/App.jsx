import { Routes, Route, Link } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ProductDetail from './pages/ProductDetail.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">Price Tracker</Link>
        <nav>
          <Link to="/">Search</Link>
          <Link to="/dashboard">Dashboard</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/products/:id" element={<ProductDetail />} />
        </Routes>
      </main>
    </div>
  );
}
