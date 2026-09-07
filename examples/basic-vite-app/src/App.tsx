import Header from './components/Header.js';
import Sidebar from './components/Sidebar.js';
import Card from './components/Card.js';
import ContactForm from './components/ContactForm.js';

export default function App() {
  return (
    <div className="layout">
      <Header />
      <div className="body">
        <Sidebar />
        <main className="content">
          <Card title="Welcome" body="This is the validity-verify example app." />
          <Card title="Activity" body="Nothing has happened yet." />
          <ContactForm />
        </main>
      </div>
    </div>
  );
}
