export interface CardProps {
  title: string;
  body: string;
}

export default function Card({ title, body }: CardProps) {
  return (
    <article className="card" data-validity-component="Card">
      <h3 className="card-title">{title}</h3>
      <p className="card-body">{body}</p>
    </article>
  );
}
