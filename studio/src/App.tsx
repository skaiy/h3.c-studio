import { Routes, Route } from 'react-router'
import { I18nProvider } from './lib/i18n'
import Home from './pages/Home'

export default function App() {
  return (
    <I18nProvider>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </I18nProvider>
  )
}
